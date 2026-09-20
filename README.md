# Email Rendering Lab

A local, **non-sending** workbench for importing raw MIME messages and emulating
how different mail clients choose what to display across
`multipart/alternative`, `multipart/related` and attachments.

- **Backend** parses the raw MIME tree (preserving part hierarchy, Content-ID,
  Content-Location, raw headers and transfer encoding), performs client
  selection, analyzes resource references and serves a sanitized preview
  document. No email is ever sent and the remote proxy never opens a network
  connection — it returns a deterministic local stub.
- **Frontend** shows the selected body in a sandboxed iframe, the resource
  graph (CID / Content-Location / remote / attachments) and the raw MIME
  inspector. Every render node, resource and attachment jumps back to its
  source MIME part.

## Run

```bash
npm install
npm run dev        # vite UI on :4173, API on :4174 (proxied)
npm test           # vitest
npm run build      # type-check + production bundle
npm start          # serve API + built UI from :4174
```

## What it demonstrates

| Concern | Where |
| --- | --- |
| Raw part hierarchy, CID, Content-Location, transfer encoding retained | `src/server/mime.ts` |
| Client profile selection for alternative / related / attachments | `src/server/selector.ts` |
| Related resources only resolve **inside their enclosing `multipart/related`**; a CID that exists elsewhere in the same message is reported `cross_message` | `selector.ts → relatedScope / analyzeHtmlRefs` |
| Sandboxed iframe (`sandbox=""`, no scripts) with server-side HTML scrubbing and URL rewriting | `src/server/htmlView.ts`, `RenderNodeView` |
| Unknown external references are neutralized to a placeholder by default; remote only loads (via the offline simulated proxy) for an opt-in profile | `htmlView.ts`, `/proxy` route |
| Switching client profile cannot let a slow earlier response overwrite the current selection (generation tokens + abort) | `src/client/requestToken.ts`, `App.tsx` |
| Branch-local parse errors (corrupt base64, unknown CTE, headerless blob, unterminated/empty multipart, bad charset) keep the rest of the message rendering | `mime.ts`, per-part `error` field |

### Built-in scenarios

1. **Newsletter** — nested `mixed → alternative → related`, present CIDs, a
   missing CID, a remote tracker (blocked by default) and a bare relative URL.
2. **Dupes** — duplicate Content-ID (`<pic@x>`) and two attachments named
   `notes.txt`; alternative nested inside related.
3. **Damaged** — unknown transfer encoding on the HTML branch (plain-text
   fallback wins), a headerless corrupt child, an unterminated multipart and a
   corrupt base64 attachment.
4. **Plain** — text-only message rendered by every client.
5. **Cross-message CID** — the referenced image exists in a sibling section of
   the message but outside `multipart/related`; the reference must not resolve.

You can also paste an arbitrary raw message with **Import MIME**.

## API

| Method & path | Purpose |
| --- | --- |
| `GET /api/client-profiles` | client emulation profiles |
| `GET /api/messages` | built-in + imported messages with error/duplicate summary |
| `POST /api/messages` `{name?, raw}` | import a raw MIME message |
| `GET /api/messages/:id/tree` | full raw part tree summaries |
| `GET /api/messages/:id/selection?profile=` | selected nodes, resources, attachments, notices + sanitized preview HTML |
| `GET /api/messages/:id/parts/:partId` | raw headers/source + decoded text for the inspector |
| `GET /api/messages/:id/parts/:partId/raw` | transfer-decoded bytes of one part |
| `GET /api/messages/:id/proxy?url=https%3A%2F%2F...` | simulated offline remote proxy (HTTPS only) |
