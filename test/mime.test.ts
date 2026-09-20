import { describe, expect, it } from 'vitest';
import { parseMime, decodeTextPart, findPart, walk } from '../src/server/mime.js';
import { selectForClient } from '../src/server/selector.js';
import { SAMPLES } from '../src/server/samples.js';

function sample(id: string) {
  const raw = SAMPLES.find((s) => s.id === id)!.raw;
  return parseMime(raw);
}

describe('MIME parser', () => {
  it('preserves the raw part hierarchy, CID and transfer encoding', () => {
    const tree = sample('newsletter');
    const types: string[] = [];
    walk(tree.root, (p) => types.push(p.contentType.type));
    expect(types).toContain('multipart/mixed');
    expect(types).toContain('multipart/alternative');
    expect(types).toContain('multipart/related');
    expect(types).toContain('text/html');
    expect(types).toContain('text/plain');
    expect(types).toContain('image/png');
    expect(types).toContain('application/pdf');

    const png = findPart(tree.root, 'p0.0.1.1')!;
    expect(png.cid).toBe('logo@news');
    expect(
      png.headers.find((h) => h.name.toLowerCase() === 'content-transfer-encoding')?.value,
    ).toBe('base64');
    // raw headers/body retained for the inspector
    expect(png.rawSource).toContain('Content-ID: <logo@news>');
    expect(png.rawBody).toBeTruthy();
  });

  it('keeps raw hierarchy stable via dotted ids (parent contains children)', () => {
    const tree = sample('newsletter');
    const alt = findPart(tree.root, 'p0.0.1')!;
    expect(alt.contentType.type).toBe('multipart/related');
    expect(alt.children!.length).toBe(3);
    expect(alt.children![0].id).toBe('p0.0.1.0');
  });

  it('decodes quoted-printable + charset text and records decoded size', () => {
    const tree = sample('newsletter');
    const html = findPart(tree.root, 'p0.0.1.0')!;
    const { text, error } = decodeTextPart(html);
    expect(error).toBeUndefined();
    expect(text).toContain('Lab Newsletter');
    expect(html.decodedSize).toBeGreaterThan(0);
  });

  it('isolates corrupt parts: blob child flagged, root still parses', () => {
    const tree = sample('damaged');
    // Root mixed is unterminated -> a branch error, not a blank message
    expect(tree.root.contentType.type).toBe('multipart/mixed');
    expect(tree.root.children!.length).toBeGreaterThanOrEqual(3);

    const blob = findPart(tree.root, 'p0.1')!;
    expect(blob.error).toBeTruthy();
    expect(blob.error!.code).toBe('malformed_part');

    // the plain-text alternative remains intact
    const text = findPart(tree.root, 'p0.0.1')!;
    expect(text.contentType.type).toBe('text/plain');
    expect(decodeTextPart(text).text).toContain('Plain text fallback');

    // global errors list records both branch problems without losing the tree
    const codes = tree.errors.map((e) => e.code);
    expect(codes).toContain('unterminated_multipart');
    expect(codes).toContain('malformed_part');
  });

  it('flags invalid base64 attachment without dropping other parts', () => {
    const tree = sample('damaged');
    const broken = findPart(tree.root, 'p0.2')!;
    expect(broken.error?.code).toMatch(/invalid_base64|unknown_transfer_encoding/);
  });

  it('detects duplicate Content-IDs and duplicate attachment filenames', () => {
    const tree = sample('dupes');
    expect(tree.duplicateCids).toEqual(['pic@x']);
    expect(tree.duplicateAttachmentNames).toEqual(['notes.txt']);
  });
});

describe('client selection', () => {
  it('HTML client picks html over plain text in alternative', () => {
    const tree = sample('newsletter');
    const sel = selectForClient(tree, 'strict_html');
    expect(sel.nodes.some((n) => n.kind === 'html')).toBe(true);
    expect(sel.nodes.some((n) => n.kind === 'text')).toBe(false);
  });

  it('nested alternative inside related is traversed (dup sample)', () => {
    const tree = sample('dupes');
    const sel = selectForClient(tree, 'strict_html');
    const htmlNode = sel.nodes.find((n) => n.kind === 'html');
    expect(htmlNode).toBeTruthy();
    // part path: mixed.related.alternative.html => p0.0.0.1
    expect(htmlNode!.partId).toBe('p0.0.0.1');
  });

  it('text-only client picks plain text even when html exists', () => {
    const tree = sample('newsletter');
    const sel = selectForClient(tree, 'text_only');
    expect(sel.nodes.some((n) => n.kind === 'text')).toBe(true);
    expect(sel.nodes.some((n) => n.kind === 'html')).toBe(false);
  });

  it('damaged html branch falls back to plain text, message not blank', () => {
    const tree = sample('damaged');
    const sel = selectForClient(tree, 'strict_html');
    const kinds = sel.nodes.map((n) => n.kind);
    expect(kinds).toContain('text');
    // a notice explains the skipped branch
    expect(sel.notices.join(' ')).toMatch(/fall|damaged|unreadable|base64|garbage/i);
  });

  it('plain-only message renders text for an html-capable client', () => {
    const tree = sample('plain');
    const sel = selectForClient(tree, 'strict_html');
    expect(sel.nodes[0].kind).toBe('text');
    expect(sel.nodes[0].content ?? '').toContain('Just text.');
  });

  it('collects attachments and marks same-name collisions', () => {
    const tree = sample('dupes');
    const sel = selectForClient(tree, 'strict_html');
    const names = sel.attachments.filter((a) => a.fileName === 'notes.txt');
    expect(names.length).toBe(2);
    expect(names.every((a) => a.nameCollision)).toBe(true);
  });
});

describe('related resource containment', () => {
  it('in-scope CID resolves; missing CID is not_found; remote blocked by default', () => {
    const tree = sample('newsletter');
    const sel = selectForClient(tree, 'strict_html');
    const byRaw = new Map(sel.resources.map((r) => [r.raw, r]));
    const ok = byRaw.get('cid:logo@news')!;
    expect(ok.status).toBe('ok');
    expect(ok.targetPartId).toBe('p0.0.1.1');

    const missing = byRaw.get('cid:footer-nowhere@news')!;
    expect(missing.status).toBe('not_found');
    expect(missing.targetPartId).toBeNull();

    const remote = byRaw.get('https://tracker.example.invalid/pixel.gif')!;
    expect(remote.status).toBe('blocked_remote');
  });

  it('allows remote only for the profile that opts in (still via proxy)', () => {
    const tree = sample('newsletter');
    const strict = selectForClient(tree, 'strict_html');
    const webmail = selectForClient(tree, 'html_prefer_related');
    const remoteStrict = strict.resources.find((r) => r.kind === 'remote' && /tracker/.test(r.raw));
    const remoteWebmail = webmail.resources.find((r) => r.kind === 'remote' && /tracker/.test(r.raw));
    expect(remoteStrict!.status).toBe('blocked_remote');
    expect(remoteWebmail!.status).toBe('ok');
    expect(remoteWebmail!.targetPartId).toBeNull(); // remote is never a part
  });

  it('blocks a CID defined outside the related group (cross-message guard)', () => {
    const tree = sample('crossmessage');
    const sel = selectForClient(tree, 'strict_html');
    const ref = sel.resources.find((r) => r.raw === 'cid:logo@x')!;
    expect(ref.status).toBe('cross_message');
    expect(ref.targetPartId).toBeNull();
    // the image exists in the message, just not inside the related container
    const img = findPart(tree.root, 'p0.1')!;
    expect(img.cid).toBe('logo@x');
  });

  it('duplicate CID resolves to the first match and is flagged', () => {
    const tree = sample('dupes');
    const sel = selectForClient(tree, 'strict_html');
    const ref = sel.resources.find((r) => r.raw === 'cid:pic@x')!;
    expect(ref.status).toBe('duplicate_cid');
    expect(ref.targetPartId).toBe('p0.0.1');
  });
});
