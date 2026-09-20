import express from 'express';
import {fileURLToPath} from 'node:url';
import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {
  decodeTextPart,
  decodeTransferEncoding,
  findPart,
  parseMime,
  summarizePart,
  walk,
  type MimeTree,
} from './mime.js';
import {CLIENT_PROFILES, getProfile, selectForClient} from './selector.js';
import {buildPreviewDocument} from './htmlView.js';
import {SAMPLES} from './samples.js';

type StoredMessage = {
  id: string;
  name: string;
  builtin: boolean;
  raw: string;
  tree: MimeTree;
  createdAt: string;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const messages = new Map<string, StoredMessage>();
let seq = 0;

function seed(): void {
  for (const sample of SAMPLES) {
    messages.set(sample.id, {
      id: sample.id,
      name: sample.name,
      builtin: true,
      raw: sample.raw,
      tree: parseMime(sample.raw),
      createdAt: new Date(0).toISOString(),
    });
  }
}
seed();

function listParts(tree: MimeTree) {
  const parts: ReturnType<typeof summarizePart>[] = [];
  walk(tree.root, (p) => parts.push(summarizePart(p)));
  return parts;
}

function load(req: express.Request, res: express.Response): StoredMessage | null {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const msg = messages.get(String(id));
  if (!msg) {
    res.status(404).json({error: 'message_not_found', messageId: req.params.id});
    return null;
  }
  return msg;
}

export function createApp() {
  const app = express();
  app.use(express.json({limit: '10mb'}));

  app.get('/api/health', (_req, res) => res.json({ok: true}));

  app.get('/api/client-profiles', (_req, res) => {
    res.json(
      CLIENT_PROFILES.map(({id, label, description, textOnly, useRelated, inlineImages, allowRemote, lenient}) => ({
        id,
        label,
        description,
        textOnly,
        useRelated,
        inlineImages,
        allowRemote,
        lenient,
      })),
    );
  });

  app.get('/api/messages', (_req, res) => {
    res.json(
      [...messages.values()].map((m) => ({
        id: m.id,
        name: m.name,
        builtin: m.builtin,
        createdAt: m.createdAt,
        partCount: listParts(m.tree).length,
        errorCount: m.tree.errors.length,
        duplicateCids: m.tree.duplicateCids,
        duplicateAttachmentNames: m.tree.duplicateAttachmentNames,
      })),
    );
  });

  app.post('/api/messages', (req, res) => {
    const raw = typeof req.body?.raw === 'string' ? req.body.raw : '';
    if (!raw.trim()) {
      return res.status(400).json({error: 'empty_message', message: 'raw MIME text is required'});
    }
    const id = `import-${Date.now().toString(36)}-${(seq++).toString(36)}`;
    const tree = parseMime(raw);
    messages.set(id, {
      id,
      name: String(req.body.name || 'Imported message').slice(0, 120),
      builtin: false,
      raw,
      tree,
      createdAt: new Date().toISOString(),
    });
    res.status(201).json({id});
  });

  app.get('/api/messages/:id/tree', (req, res) => {
    const msg = load(req, res);
    if (!msg) return;
    res.json({
      id: msg.id,
      name: msg.name,
      builtin: msg.builtin,
      parts: listParts(msg.tree),
      rootId: msg.tree.root.id,
      errors: msg.tree.errors,
      duplicateCids: msg.tree.duplicateCids,
      duplicateAttachmentNames: msg.tree.duplicateAttachmentNames,
    });
  });

  app.get('/api/messages/:id/selection', (req, res) => {
    const msg = load(req, res);
    if (!msg) return;
    const profileId = String(req.query.profile || CLIENT_PROFILES[0].id);
    if (!CLIENT_PROFILES.some((p) => p.id === profileId)) {
      return res.status(400).json({error: 'unknown_profile', profile: profileId});
    }
    const profile = getProfile(profileId);
    const selection = selectForClient(msg.tree, profileId);

    // Render the server-rewritten HTML document for html nodes.
    const nodes = selection.nodes.map((node) => {
      if (node.kind === 'html' && node.content !== undefined) {
        return {
          ...node,
          html: buildPreviewDocument(node.content, {
            messageId: msg.id,
            resources: selection.resources,
            allowRemote: profile.allowRemote,
          }),
          // keep raw text too, so the "source" tab can show it
          text: node.content,
          content: undefined,
        };
      }
      return node;
    });

    res.json({...selection, nodes});
  });

  app.get('/api/messages/:id/parts/:partId', (req, res) => {
    const msg = load(req, res);
    if (!msg) return;
    const part = findPart(msg.tree.root, req.params.partId);
    if (!part) return res.status(404).json({error: 'part_not_found', partId: req.params.partId});

    const summary = summarizePart(part);
    let decodedText: string | null = null;
    let decodeError = null;
    if (!part.children) {
      if (part.contentType.type.startsWith('text/')) {
        const r = decodeTextPart(part);
        decodedText = r.text;
        decodeError = r.error ?? null;
      }
    }
    res.json({
      ...summary,
      rawSource: part.rawSource,
      rawBody: part.rawBody ?? null,
      decodedText,
      decodeError,
    });
  });

  app.get('/api/messages/:id/parts/:partId/raw', (req, res) => {
    const msg = load(req, res);
    if (!msg) return;
    const part = findPart(msg.tree.root, req.params.partId);
    if (!part || part.children) {
      return res.status(404).json({error: 'part_not_found', partId: req.params.partId});
    }
    const {bytes} = decodeTransferEncoding(part);
    const ct = part.contentType.type || 'application/octet-stream';
    const params = Object.entries(part.contentType.params)
      .filter(([k]) => k !== 'boundary')
      .map(([k, v]) => `; ${k}="${v.replace(/"/g, '\\"')}"`)
      .join('');
    res.set('Content-Type', `${ct}${params}`);
    res.set('X-Content-Id', part.cid ?? '');
    res.set('Cache-Control', 'no-store');
    res.send(Buffer.from(bytes));
  });

  // Simulated remote proxy: no network access. Returns a deterministic stub
  // whenever a profile permits remote content, so layout works while the lab
  // stays offline and never sends anything.
  app.get('/api/messages/:id/proxy', (req, res) => {
    const msg = load(req, res);
    if (!msg) return;
    const url = String(req.query.url || '');
    if (!/^https:\/\//i.test(url)) {
      return res.status(400).json({error: 'only_https_proxied'});
    }
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return 'unknown';
      }
    })();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40">
      <rect width="120" height="40" fill="#101826" stroke="#3b82f6"/>
      <text x="60" y="17" font-family="sans-serif" font-size="9" fill="#93c5fd" text-anchor="middle">proxied remote</text>
      <text x="60" y="31" font-family="sans-serif" font-size="8" fill="#64748b" text-anchor="middle">${host.slice(0, 18)}</text>
    </svg>`;
    res.set('Content-Type', 'image/svg+xml');
    res.set('X-Render-Lab', 'simulated-remote');
    res.set('Cache-Control', 'no-store');
    res.send(svg);
  });

  // Serve the built front-end in production (`npm run build && npm start`).
  const dist = join(__dirname, '../../dist');
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.use((req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(join(dist, 'index.html'));
    });
  }

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
