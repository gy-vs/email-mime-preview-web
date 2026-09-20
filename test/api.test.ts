import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/server/index.js';

describe('HTTP API', () => {
  it('lists builtin samples and their tree metadata', async () => {
    const app = createApp();
    const list = await request(app).get('/api/messages').expect(200);
    const ids = list.body.map((m: { id: string }) => m.id);
    expect(ids).toContain('newsletter');
    expect(ids).toContain('dupes');
    expect(ids).toContain('damaged');
    expect(ids).toContain('crossmessage');

    const tree = await request(app).get('/api/messages/newsletter/tree').expect(200);
    expect(tree.body.rootId).toBe('p0');
    expect(tree.body.parts.length).toBeGreaterThan(5);
    // every part keeps transfer encoding and cid metadata
    const png = tree.body.parts.find((p: { cid: string }) => p.cid === 'logo@news');
    expect(png.encoding).toBe('base64');
  });

  it('produces profile-specific selections and rejects unknown profiles', async () => {
    const app = createApp();
    const strict = await request(app)
      .get('/api/messages/newsletter/selection?profile=strict_html')
      .expect(200);
    expect(strict.body.nodes.some((n: { kind: string }) => n.kind === 'html')).toBe(true);
    // html node carries the rewritten preview document, not the raw content
    const htmlNode = strict.body.nodes.find((n: { kind: string }) => n.kind === 'html');
    expect(htmlNode.html).toContain('<!doctype html>');
    expect(htmlNode.html).toContain('/api/messages/newsletter/parts/p0.0.1.1/raw');
    // remote tracker blocked by default
    expect(htmlNode.html).not.toContain('https://tracker.example.invalid/pixel.gif');

    const textOnly = await request(app)
      .get('/api/messages/newsletter/selection?profile=text_only')
      .expect(200);
    expect(textOnly.body.nodes.some((n: { kind: string }) => n.kind === 'text')).toBe(true);

    await request(app).get('/api/messages/newsletter/selection?profile=nope').expect(400);
  });

  it('serves a related resource by part id and blocks cross-message cid', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/api/messages/newsletter/parts/p0.0.1.1/raw')
      .expect(200)
      .expect('Content-Type', /image\/png/);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.headers['x-content-id']).toBe('logo@news');

    const sel = await request(app)
      .get('/api/messages/crossmessage/selection?profile=strict_html')
      .expect(200);
    const ref = sel.body.resources.find((r: { raw: string }) => r.raw === 'cid:logo@x');
    expect(ref.status).toBe('cross_message');
    expect(ref.targetPartId).toBeNull();
  });

  it('simulated remote proxy never fetches the network and only accepts https', async () => {
    const app = createApp();
    const ok = await request(app)
      .get('/api/messages/newsletter/proxy?url=' + encodeURIComponent('https://tracker.example/x'))
      .expect(200)
      .expect('X-Render-Lab', 'simulated-remote');
    expect(ok.headers['content-type']).toMatch(/image\/svg\+xml/);
    await request(app)
      .get('/api/messages/newsletter/proxy?url=' + encodeURIComponent('http://tracker.example/x'))
      .expect(400);
  });

  it('imports a raw MIME message and still parses a damaged one without blanking', async () => {
    const app = createApp();
    const imported = await request(app)
      .post('/api/messages')
      .send({
        name: 'unit import',
        raw:
          'Content-Type: multipart/mixed; boundary="b"\r\n\r\n' +
          '--b\r\nContent-Type: text/plain\r\n\r\nhi\r\n' +
          '--b\r\nthis blob has no headers\r\n' +
          '--b--\r\n',
      })
      .expect(201);
    expect(imported.body.id).toMatch(/^import-/);

    const tree = await request(app).get(`/api/messages/${imported.body.id}/tree`).expect(200);
    expect(tree.body.parts[0].contentType).toBe('multipart/mixed');
    // the corrupt child is flagged but the text sibling is present
    expect(tree.body.errors.length).toBeGreaterThan(0);

    const sel = await request(app)
      .get(`/api/messages/${imported.body.id}/selection?profile=strict_html`)
      .expect(200);
    expect(sel.body.nodes[0].kind).toBe('text');
  });

  it('rejects an empty import and unknown messages/parts', async () => {
    const app = createApp();
    await request(app).post('/api/messages').send({ raw: '   ' }).expect(400);
    await request(app).get('/api/messages/nope/tree').expect(404);
    await request(app).get('/api/messages/newsletter/parts/p9.9.9').expect(404);
  });
});
