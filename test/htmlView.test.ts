import { describe, expect, it } from 'vitest';
import { buildPreviewDocument } from '../src/server/htmlView.js';
import type { ResourceRef } from '../src/server/selector.js';

const ctx = (resources: ResourceRef[], messageId = 'm1', allowRemote = false) => ({
  messageId,
  resources,
  allowRemote,
});

const cidRef = (over: Partial<ResourceRef>): ResourceRef => ({
  raw: 'cid:x@y',
  kind: 'cid',
  targetPartId: 'p0.1',
  status: 'ok',
  detail: '',
  ...over,
});

describe('preview HTML rewriting / sandboxing', () => {
  it('rewrites an in-scope cid reference to the resource proxy URL', () => {
    const doc = buildPreviewDocument(
      '<img src="cid:x@y">',
      ctx([cidRef({})]),
    );
    expect(doc).toContain('/api/messages/m1/parts/p0.1/raw');
  });

  it('neutralizes blocked remote and unknown references (loaded by default never)', () => {
    const doc = buildPreviewDocument(
      '<img src="https://evil.example/a.gif"><img src="cid:x@y">',
      ctx([cidRef({ status: 'blocked_remote', targetPartId: null, raw: 'https://evil.example/a.gif' })]),
    );
    expect(doc).not.toContain('https://evil.example/a.gif');
    expect(doc).toContain('data:image/svg+xml');
  });

  it('proxies remote references only when the profile allows it', () => {
    const remote: ResourceRef = {
      raw: 'https://tracker.example/p.gif',
      kind: 'remote',
      targetPartId: null,
      status: 'ok',
      detail: '',
    };
    const allowed = buildPreviewDocument('<img src="https://tracker.example/p.gif">', ctx([remote], 'm1', true));
    expect(allowed).toContain('/api/messages/m1/proxy?url=');

    const blocked = buildPreviewDocument('<img src="https://tracker.example/p.gif">', ctx([{ ...remote, status: 'blocked_remote' }], 'm1', false));
    expect(blocked).not.toContain('https://tracker.example/p.gif');
  });

  it('rewrites missing and cross-message CIDs to placeholders', () => {
    const refs: ResourceRef[] = [
      cidRef({ raw: 'cid:gone@y', status: 'not_found', targetPartId: null }),
      cidRef({ raw: 'cid:foreign@y', status: 'cross_message', targetPartId: null }),
    ];
    const doc = buildPreviewDocument(
      '<img src="cid:gone@y"><img src="cid:foreign@y">',
      ctx(refs),
    );
    expect(doc).not.toContain('/parts/');
    expect(doc).toMatch(/data:image\/svg\+xml/g);
  });

  it('strips scripts, event handlers and dangerous URL schemes', () => {
    const html =
      '<script>alert(1)</script>' +
      '<img src="x" onerror="alert(1)">' +
      '<a href="javascript:alert(1)">go</a>' +
      '<iframe src="https://evil"></iframe>' +
      '<p>hello</p>';
    const doc = buildPreviewDocument(html, ctx([]));
    expect(doc.toLowerCase()).not.toContain('<script');
    expect(doc).not.toContain('onerror');
    expect(doc).not.toContain('javascript:');
    expect(doc.toLowerCase()).not.toContain('<iframe');
    expect(doc).toContain('hello');
  });

  it('duplicate-cid ref points at the first matching part but remains flagged by selector upstream', () => {
    const doc = buildPreviewDocument(
      '<img src="cid:dup@y">',
      ctx([cidRef({ raw: 'cid:dup@y', status: 'duplicate_cid', targetPartId: 'p0.2' })]),
    );
    expect(doc).toContain('/api/messages/m1/parts/p0.2/raw');
  });
});
