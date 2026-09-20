# MIME Rendering Lab

Local workbench for importing MIME message trees and simulating how different
clients pick and render `multipart/alternative` / `multipart/related` branches
and attachments. Nothing is ever sent — the backend only parses, selects and
proxies.

## Run

```bash
npm install
npm run dev      # server on :4174, vite dev on :4173
npm test         # API / selection / isolation tests
npm run build    # typecheck + production bundle
```

## Model

- **Import** (`POST /api/messages` with `{name, raw}`) parses the raw source
  into a part tree. The original hierarchy, `Content-ID` and
  `Content-Transfer-Encoding` are preserved per part; parse problems
  (missing boundary, invalid base64, unknown encoding, …) are recorded as
  diagnostics on the affected part only, so a broken branch never blanks the
  whole message.
- **Client profiles** (`GET /api/clients`): `desktop`, `webmail`, `mobile`,
  `plain`. `POST /api/messages/:id/render {client}` returns a render plan:
  chosen body part, cid resource map, attachments, blocked external refs and
  diagnostics. Selection recurses through nested `alternative` / `related` /
  `mixed`; a plain-text client gets the text branch, or text derived from HTML
  when no text branch exists.
- **Render tokens** are monotonic per message. The UI applies a preview only
  if its token is not older than the last applied one, so a slow response from
  a previous client-profile switch can never overwrite the current preview.
- **Resource proxy** (`GET /api/messages/:id/resources/:partId`) is scoped by
  message id: a `cid:` reference can only resolve to a part of the same
  message — cross-message references are impossible by construction and
  unknown part ids return 404.
- **Preview** runs in a sandboxed `<iframe>` (no scripts, no top navigation).
  `cid:` URLs are rewritten to proxy URLs; unknown external subresources are
  replaced with placeholders and listed as blocked; `webmail`/`mobile`/`plain`
  profiles additionally strip scripts, forms and event handlers.

## Covered edge cases

Nested `alternative`/`related`, duplicate `Content-ID` (first wins, duplicate
flagged), missing `cid:` resources, plain-text fallback (including text
derived from an HTML-only message), same-name attachments (disambiguated by
part id), corrupted parts (invalid base64 stays local to that part, proxy
serves best-effort with `X-Decode-Warning`), and multipart parts with a
missing boundary.

The UI links both ways: click a body/resource/attachment chip in the preview
to jump back to the corresponding node in the MIME tree.
