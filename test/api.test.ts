import {beforeAll, describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';

const app = createApp();
const NEWS = 'seed-newsletter';
const PLAIN = 'seed-plain';

async function render(id: string, client: string) {
  const res = await request(app).post(`/api/messages/${id}/render`).send({client}).expect(200);
  return res.body;
}

describe('mime tree import', () => {
  it('keeps hierarchy, Content-ID and transfer encoding', async () => {
    const res = await request(app).get(`/api/messages/${NEWS}`).expect(200);
    const root = res.body.tree;
    expect(root.contentType).toBe('multipart/mixed');
    const [alt, pdf1, pdf2, bin] = root.children;
    expect(alt.contentType).toBe('multipart/alternative');
    const [text, related] = alt.children;
    expect(text.contentType).toBe('text/plain');
    expect(text.transferEncoding).toBe('quoted-printable');
    expect(related.contentType).toBe('multipart/related');
    const [html, logo1, logo2] = related.children;
    expect(html.contentType).toBe('text/html');
    expect(logo1.contentId).toBe('logo');
    expect(logo2.contentId).toBe('logo');
    expect(logo1.transferEncoding).toBe('base64');
    expect(pdf1.filename).toBe('report.pdf');
    expect(pdf2.filename).toBe('report.pdf');
    expect(bin.filename).toBe('data.bin');
  });

  it('rejects empty imports and keeps parse errors local to the broken branch', async () => {
    await request(app).post('/api/messages').send({raw: '   '}).expect(400);
    const broken = [
      'Subject: broken multipart',
      'Content-Type: multipart/mixed',
      '',
      'no boundary declared, body stays as raw text',
    ].join('\r\n');
    const res = await request(app).post('/api/messages').send({name: 'broken', raw: broken}).expect(201);
    expect(res.body.tree.diagnostics.some((d: {code: string}) => d.code === 'missing_boundary')).toBe(true);
    const plan = await render(res.body.summary.id, 'desktop');
    expect(plan.body).toBeNull();
    expect(plan.diagnostics.some((d: {code: string}) => d.code === 'no_displayable_body')).toBe(true);
  });
});

describe('client profile selection', () => {
  it('renders nested alternative/related html for html clients', async () => {
    const plan = await render(NEWS, 'desktop');
    expect(plan.body.partId).toBe('1.1.2.1');
    expect(plan.body.mediaType).toBe('text/html');
    expect(plan.body.html).toContain('Quarterly');
  });

  it('falls back to the plain branch for text clients', async () => {
    const plan = await render(NEWS, 'plain');
    expect(plan.body.partId).toBe('1.1.1');
    expect(plan.body.mediaType).toBe('text/plain');
    expect(plan.body.derivedFromHtml).toBe(false);
    expect(plan.body.html).toContain('plain text version');
  });

  it('derives text when the client wants plain but only html exists', async () => {
    const raw = ['Subject: html only', 'Content-Type: text/html', '', '<p>Hello <b>only html</b></p>'].join('\r\n');
    const res = await request(app).post('/api/messages').send({raw}).expect(201);
    const plan = await render(res.body.summary.id, 'plain');
    expect(plan.body.derivedFromHtml).toBe(true);
    expect(plan.body.html).toContain('only html');
    expect(plan.body.html).not.toContain('<b>');
    expect(plan.diagnostics.some((d: {code: string}) => d.code === 'html_as_text_fallback')).toBe(true);
  });

  it('issues monotonically increasing render tokens per message', async () => {
    const first = await render(NEWS, 'desktop');
    const second = await render(NEWS, 'webmail');
    expect(second.renderToken).toBeGreaterThan(first.renderToken);
  });

  it('rejects unknown client profiles', async () => {
    await request(app).post(`/api/messages/${NEWS}/render`).send({client: 'nope'}).expect(400);
  });
});

describe('resources and cid resolution', () => {
  it('maps related resources, flags duplicate Content-ID and missing references', async () => {
    const plan = await render(NEWS, 'desktop');
    const ok = plan.resources.find((r: {status: string}) => r.status === 'ok');
    const dup = plan.resources.find((r: {status: string}) => r.status === 'duplicate');
    expect(ok.cid).toBe('logo');
    expect(ok.partId).toBe('1.1.2.2');
    expect(dup.cid).toBe('logo');
    expect(dup.partId).toBe('1.1.2.3');
    expect(plan.missingResources.map((m: {cid: string}) => m.cid)).toContain('absent');
    expect(plan.diagnostics.some((d: {code: string; partId: string}) => d.code === 'duplicate_content_id' && d.partId === '1.1.2.3')).toBe(true);
    expect(plan.body.html).toContain(`/api/messages/${NEWS}/resources/1.1.2.2`);
    expect(plan.body.html).toContain('#missing-resource');
  });

  it('serves decoded resources only within their own message scope', async () => {
    const res = await request(app).get(`/api/messages/${NEWS}/resources/1.1.2.2`).expect(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.body.slice(1, 4).toString()).toBe('PNG');
    // unknown part
    await request(app).get(`/api/messages/${NEWS}/resources/9.9`).expect(404);
    // cross-message: the newsletter part id does not exist on the plain message
    await request(app).get(`/api/messages/${PLAIN}/resources/1.1.2.2`).expect(404);
    // cross-message: even a valid local part id is scoped to its own message
    const plainTree = await request(app).get(`/api/messages/${PLAIN}`).expect(200);
    expect(plainTree.body.tree.id).toBe('1');
    const plan = await render(PLAIN, 'desktop');
    expect(plan.body.html).not.toContain(`/api/messages/${NEWS}/`);
  });

  it('blocks unknown external references by default and records them', async () => {
    const plan = await render(NEWS, 'desktop');
    const tracker = plan.externalRefs.find((e: {url: string}) => e.url.includes('tracker.example.com'));
    expect(tracker.blocked).toBe(true);
    expect(plan.body.html).not.toContain('https://tracker.example.com/pixel.png');
    const link = plan.externalRefs.find((e: {kind: string}) => e.kind === 'link');
    expect(link.url).toBe('https://example.com/offer');
  });

  it('sanitizes active content for webmail but keeps it for desktop', async () => {
    const webmail = await render(NEWS, 'webmail');
    expect(webmail.body.html).not.toContain('<script>');
    expect(webmail.diagnostics.some((d: {code: string}) => d.code === 'sanitized')).toBe(true);
    const desktop = await render(NEWS, 'desktop');
    expect(desktop.body.html).toContain('<script>');
  });
});

describe('attachments and corrupted parts', () => {
  it('lists same-name attachments as distinct parts', async () => {
    const plan = await render(NEWS, 'desktop');
    const reports = plan.attachments.filter((a: {filename: string}) => a.filename === 'report.pdf');
    expect(reports).toHaveLength(2);
    expect(reports[0].partId).not.toBe(reports[1].partId);
    expect(reports[0].duplicateName).toBe(true);
    expect(reports[0].downloadUrl).not.toBe(reports[1].downloadUrl);
    expect(plan.diagnostics.some((d: {code: string}) => d.code === 'duplicate_attachment_name')).toBe(true);
  });

  it('does not turn rejected alternative branches into attachments', async () => {
    const plan = await render(NEWS, 'desktop');
    expect(plan.attachments.map((a: {partId: string}) => a.partId)).toEqual(['1.2', '1.3', '1.4']);
  });

  it('keeps a corrupted part local: body still renders, part flagged, proxy warns', async () => {
    const plan = await render(NEWS, 'desktop');
    expect(plan.body).not.toBeNull();
    const diag = plan.diagnostics.find((d: {code: string}) => d.code === 'invalid_base64');
    expect(diag.partId).toBe('1.4');
    const bin = plan.attachments.find((a: {filename: string}) => a.filename === 'data.bin');
    expect(bin.partId).toBe('1.4');
    const res = await request(app).get(`/api/messages/${NEWS}/resources/1.4`).expect(200);
    expect(res.headers['x-decode-warning']).toBe('invalid_base64');
  });

  it('downloads attachments with a filename via the proxy', async () => {
    const res = await request(app).get(`/api/messages/${NEWS}/resources/1.2?download=1`).expect(200);
    expect(res.headers['content-disposition']).toContain('report.pdf');
    expect(res.body.toString('utf8')).toContain('%PDF-1.4 fake pdf 1');
  });
});
