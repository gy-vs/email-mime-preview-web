// Produce a sanitized HTML document for the sandboxed preview iframe.
//
// - Scripts, event handlers and javascript: URL are stripped server-side as
//   defence in depth; the iframe is also sandboxed without allow-scripts.
// - References are rewritten from the selection analysis:
//     cid / content-location that resolve in scope -> /api resource URL
//     remote URL allowed by profile              -> /api proxy URL (simulated)
//     everything else                            -> neutralized placeholder
//   so an unknown external link is never loaded by default.

import type { ResourceRef } from './selector.js';

const PLACEHOLDER_SVG =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="36">
       <rect width="96" height="36" fill="#1e2430" stroke="#5a6478"/>
       <text x="48" y="23" font-family="sans-serif" font-size="10" fill="#ffb454" text-anchor="middle">blocked</text>
     </svg>`,
  );

const MISSING_SVG =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="36">
       <rect width="120" height="36" fill="#2a1410" stroke="#8a4b3c"/>
       <text x="60" y="23" font-family="sans-serif" font-size="10" fill="#ff8a70" text-anchor="middle">missing resource</text>
     </svg>`,
  );

export type RewriteContext = {
  messageId: string;
  resources: ResourceRef[];
  allowRemote: boolean;
};

const URL_ATTRS = ['src', 'href', 'poster', 'background', 'data'];

export function buildPreviewDocument(html: string, ctx: RewriteContext): string {
  const byRaw = new Map<string, ResourceRef>();
  for (const r of ctx.resources) byRaw.set(r.raw, r);

  let out = stripDangerousMarkup(html);

  // Rewrite every URL-bearing attribute on tags.
  out = out.replace(
    /<([a-z][a-z0-9]*)\b([^>]*)>/gi,
    (whole, tag: string, attrs: string) => {
      const safeAttrs = rewriteAttributes(tag, attrs, byRaw, ctx);
      return `<${tag}${safeAttrs}>`;
    },
  );

  // Rewrite url(...) inside style attributes / blocks.
  out = out.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (_m, q: string, url: string) => {
    const target = rewriteUrl(url.trim(), byRaw, ctx);
    return `url(${q}${target}${q})`;
  });

  // Inject <base target=_blank> style safety is not needed in a sandboxed
  // srcdoc iframe; just wrap with a marker and force a charset.
  const cspNote = ''; // sandbox attribute on the iframe is the enforcement point
  return `<!doctype html><html><head><meta charset="utf-8">` + cspNote + `</head><body>` + out + `</body></html>`;
}

function stripDangerousMarkup(html: string): string {
  let s = html;
  // remove script/style-execution? keep <style> for layout, drop <script>
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  s = s.replace(/<script\b[^>]*\/?>/gi, '');
  s = s.replace(/<\/?script\s*>/gi, '');
  // objects / embeds / frames can load external content
  s = s.replace(/<(object|embed|iframe|frame|frameset|applet)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<(object|embed|iframe|frame|frameset|applet)\b[^>]*\/?>/gi, '');
  // meta refresh / link preloads
  s = s.replace(/<meta\b[^>]*http-equiv[^>]*>/gi, '');
  s = s.replace(/<link\b[^>]*>/gi, '');
  return s;
}

function rewriteAttributes(
  tag: string,
  attrsText: string,
  byRaw: Map<string, ResourceRef>,
  ctx: RewriteContext,
): string {
  const parts: string[] = [];
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(attrsText))) {
    const name = m[1];
    const lower = name.toLowerCase();
    const valuePart = m[3]; // includes the quote characters when quoted
    if (valuePart === undefined) {
      parts.push(name);
      continue;
    }
    const quoted = valuePart.startsWith('"') || valuePart.startsWith("'");
    const quote = quoted ? valuePart[0] : '';
    const value = quoted ? valuePart.slice(1, -1) : valuePart;

    if (lower.startsWith('on')) continue; // drop inline event handlers
    if (lower === 'style' && /(expression|javascript:|vbscript:)/i.test(value)) {
      parts.push(`${name}=""`);
      continue;
    }
    if (lower === 'srcdoc') continue;

    if (URL_ATTRS.includes(lower)) {
      const dangerousScheme = /^\s*(javascript|vbscript)\s*:/i.test(value);
      const disallowedData =
        /^\s*data\s*:/i.test(value) &&
        !/^\s*data:image\/(png|gif|jpe?g|webp|svg\+xml)/i.test(value);
      if (dangerousScheme || disallowedData) continue;
      const rewritten = rewriteUrl(value, byRaw, ctx);
      parts.push(`${name}="${rewritten}"`);
      continue;
    }
    parts.push(quoted ? `${name}=${quote}${value}${quote}` : `${name}=${value}`);
    void tag;
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

function rewriteUrl(
  value: string,
  byRaw: Map<string, ResourceRef>,
  ctx: RewriteContext,
): string {
  if (!value || value.startsWith('#') || value.startsWith('data:')) return value;
  // Idempotent: the tag pass may already have produced an internal proxy URL
  // before the style url() pass sees the same string.
  if (value.startsWith('/api/messages/')) return value;

  const ref = byRaw.get(value);
  if (ref) {
    if (ref.status === 'ok') {
      if (ref.kind === 'remote') {
        return `/api/messages/${ctx.messageId}/proxy?url=${encodeURIComponent(ref.raw)}`;
      }
      if (ref.targetPartId) {
        return `/api/messages/${ctx.messageId}/parts/${encodeURIComponent(ref.targetPartId)}/raw`;
      }
    }
    if (ref.status === 'duplicate_cid' && ref.targetPartId) {
      return `/api/messages/${ctx.messageId}/parts/${encodeURIComponent(ref.targetPartId)}/raw`;
    }
    if (ref.status === 'blocked_remote') return PLACEHOLDER_SVG;
    if (ref.status === 'not_found') return MISSING_SVG;
    if (ref.status === 'cross_message') return PLACEHOLDER_SVG;
  }

  // Unknown reference appearing in markup but absent from the analysis
  // (e.g. dynamically constructed): default to blocked, never loaded.
  if (/^https?:\/\//i.test(value) || /^\/\//.test(value)) return PLACEHOLDER_SVG;
  return PLACEHOLDER_SVG;
}
