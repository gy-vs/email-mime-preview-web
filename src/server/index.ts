import express from 'express';
import {fileURLToPath} from 'node:url';
import {MimePart, ParsedMessage, decodeText, decodeTransfer, parseMessage} from './mime';
import {CLIENT_PROFILES, buildRenderPlan} from './render';

interface StoredMessage {
  id: string;
  name: string;
  createdAt: string;
  raw: string;
  parsed: ParsedMessage;
  renderSeq: number; // monotonic render token; stale preview responses lose
}

const messages = new Map<string, StoredMessage>();
let importCounter = 0;

function summarize(message: StoredMessage) {
  let parts = 0;
  let diagnostics = 0;
  const walk = (part: MimePart) => {
    parts += 1;
    diagnostics += part.diagnostics.length;
    part.children.forEach(walk);
  };
  walk(message.parsed.root);
  return {id: message.id, name: message.name, createdAt: message.createdAt, parts, diagnostics};
}

function treeNode(part: MimePart): Record<string, unknown> {
  return {
    id: part.id,
    contentType: part.contentType,
    transferEncoding: part.transferEncoding,
    contentId: part.contentId,
    disposition: part.disposition,
    filename: part.filename,
    charset: part.charset,
    size: part.rawBody.length,
    diagnostics: part.diagnostics,
    bodyPreview: part.rawBody.slice(0, 240),
    children: part.children.map(treeNode),
  };
}

function storeMessage(name: string, raw: string, id?: string): StoredMessage {
  const message: StoredMessage = {
    id: id ?? `msg-${(++importCounter).toString(36)}-${Date.now().toString(36)}`,
    name,
    createdAt: new Date().toISOString(),
    raw,
    parsed: parseMessage(raw),
    renderSeq: 0,
  };
  messages.set(message.id, message);
  return message;
}

const CRLF = '\r\n';
const SEED_NEWSLETTER = [
  'From: Lab <lab@example.com>',
  'To: you@example.com',
  'Subject: Quarterly newsletter',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="mix"',
  '',
  '--mix',
  'Content-Type: multipart/alternative; boundary="alt"',
  '',
  '--alt',
  'Content-Type: text/plain; charset="utf-8"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Quarterly newsletter =E2=80=94 plain text version.',
  '--alt',
  'Content-Type: multipart/related; boundary="rel"',
  '',
  '--rel',
  'Content-Type: text/html; charset="utf-8"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '<html><body><h1>Quarterly =E2=80=94 newsletter</h1>',
  '<img src=3D"cid:logo" width=3D"1" height=3D"1">',
  '<img src=3D"cid:absent">',
  '<img src=3D"https://tracker.example.com/pixel.png">',
  '<p>Hello <b>world</b>, see <a href=3D"https://example.com/offer">the offer</a>.</p>',
  '<script>alert(1)</script>',
  '</body></html>',
  '--rel',
  'Content-Type: image/png',
  'Content-Transfer-Encoding: base64',
  'Content-ID: <logo>',
  'Content-Disposition: inline; filename="logo.png"',
  '',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  '--rel',
  'Content-Type: image/png',
  'Content-Transfer-Encoding: base64',
  'Content-ID: <logo>',
  '',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  '--rel--',
  '--alt--',
  '--mix',
  'Content-Type: application/pdf',
  'Content-Transfer-Encoding: base64',
  'Content-Disposition: attachment; filename="report.pdf"',
  '',
  'JVBERi0xLjQgZmFrZSBwZGYgMQ==',
  '--mix',
  'Content-Type: application/pdf',
  'Content-Transfer-Encoding: base64',
  'Content-Disposition: attachment; filename="report.pdf"',
  '',
  'JVBERi0xLjQgZmFrZSBwZGYgMg==',
  '--mix',
  'Content-Type: application/octet-stream',
  'Content-Transfer-Encoding: base64',
  'Content-Disposition: attachment; filename="data.bin"',
  '',
  '%%%not-valid-base64%%%',
  '--mix--',
  '',
].join(CRLF);

const SEED_PLAIN = [
  'From: Ops <ops@example.com>',
  'Subject: Maintenance window',
  'Content-Type: text/plain; charset="utf-8"',
  '',
  'Maintenance starts 02:00 UTC. No HTML part in this message.',
  '',
].join(CRLF);

function seed() {
  storeMessage('Newsletter (nested alternative/related)', SEED_NEWSLETTER, 'seed-newsletter');
  storeMessage('Plain notice', SEED_PLAIN, 'seed-plain');
}

export function createApp() {
  const app = express();
  app.use(express.json({limit: '10mb'}));

  app.get('/api/clients', (_req, res) => res.json(Object.values(CLIENT_PROFILES)));

  app.get('/api/messages', (_req, res) => res.json([...messages.values()].map(summarize)));

  app.post('/api/messages', (req, res) => {
    const raw = req.body?.raw;
    if (typeof raw !== 'string' || raw.trim() === '') {
      return res.status(400).json({error: 'invalid_message', detail: 'Body must include a non-empty "raw" MIME string.'});
    }
    const name = typeof req.body?.name === 'string' && req.body.name.trim() !== '' ? req.body.name.trim().slice(0, 120) : 'Imported message';
    const message = storeMessage(name, raw);
    res.status(201).json({summary: summarize(message), tree: treeNode(message.parsed.root)});
  });

  app.get('/api/messages/:id', (req, res) => {
    const message = messages.get(req.params.id);
    if (!message) return res.status(404).json({error: 'not_found'});
    res.json({summary: summarize(message), tree: treeNode(message.parsed.root)});
  });

  app.delete('/api/messages/:id', (req, res) => {
    if (!messages.delete(req.params.id)) return res.status(404).json({error: 'not_found'});
    res.status(204).end();
  });

  app.get('/api/messages/:id/parts/:partId', (req, res) => {
    const message = messages.get(req.params.id);
    const part = message?.parsed.partIndex.get(req.params.partId);
    if (!message || !part) return res.status(404).json({error: 'not_found'});
    const isText = part.contentType.startsWith('text/');
    res.json({
      id: part.id,
      headers: part.headers,
      contentType: part.contentType,
      transferEncoding: part.transferEncoding,
      contentId: part.contentId,
      disposition: part.disposition,
      filename: part.filename,
      charset: part.charset,
      diagnostics: part.diagnostics,
      rawBody: part.rawBody,
      decodedSize: part.children.length === 0 ? decodeTransfer(part).length : null,
      decodedText: isText && part.children.length === 0 ? decodeText(part) : null,
    });
  });

  app.post('/api/messages/:id/render', (req, res) => {
    const message = messages.get(req.params.id);
    if (!message) return res.status(404).json({error: 'not_found'});
    const profile = CLIENT_PROFILES[req.body?.client as string];
    if (!profile) return res.status(400).json({error: 'unknown_client', detail: `Known clients: ${Object.keys(CLIENT_PROFILES).join(', ')}`});
    // Each render request bumps the token; the client applies a preview only
    // when its token is not older than the last one it applied.
    const token = ++message.renderSeq;
    res.json(buildRenderPlan(message.parsed, message.id, profile, token));
  });

  // Resource proxy: scoped to the message id in the URL, so a cid: reference
  // can never resolve to a part of another message.
  app.get('/api/messages/:id/resources/:partId', (req, res) => {
    const message = messages.get(req.params.id);
    const part = message?.parsed.partIndex.get(req.params.partId);
    if (!message || !part || part.children.length > 0) return res.status(404).json({error: 'resource_not_found'});
    const data = decodeTransfer(part);
    res.set('Content-Type', part.contentType);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'no-store');
    if (part.diagnostics.some((d) => d.code === 'invalid_base64')) res.set('X-Decode-Warning', 'invalid_base64');
    if (req.query.download === '1') {
      const filename = (part.filename ?? `part-${part.id}`).replace(/[^\w. -]/g, '_');
      res.set('Content-Disposition', `attachment; filename="${filename}"`);
    }
    res.send(data);
  });

  return app;
}

seed();

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
