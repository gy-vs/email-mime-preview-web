// Render planning: picks the displayable branch for a given client profile,
// maps cid: resources to same-message proxy URLs, blocks unknown external
// references by default, and derives a plain-text fallback when needed.

import { MimePart, ParsedMessage, PartDiagnostic, decodeText, decodeTransfer } from './mime';

export interface ClientProfile {
  id: string;
  label: string;
  preferHtml: boolean;
  loadRemote: boolean; // load http(s) subresources
  sanitize: boolean; // strip scripts/forms/event handlers
}

export const CLIENT_PROFILES: Record<string, ClientProfile> = {
  desktop: { id: 'desktop', label: 'Desktop mail', preferHtml: true, loadRemote: false, sanitize: false },
  webmail: { id: 'webmail', label: 'Webmail', preferHtml: true, loadRemote: false, sanitize: true },
  mobile: { id: 'mobile', label: 'Mobile', preferHtml: true, loadRemote: false, sanitize: true },
  plain: { id: 'plain', label: 'Plain text', preferHtml: false, loadRemote: false, sanitize: true },
};

export interface RenderDiagnostic extends PartDiagnostic {
  partId: string | null;
}

export interface ResourceEntry {
  cid: string;
  partId: string;
  status: 'ok' | 'duplicate' | 'unreferenced';
  proxyUrl: string;
}

export interface AttachmentEntry {
  partId: string;
  filename: string;
  mediaType: string;
  size: number;
  duplicateName: boolean;
  downloadUrl: string;
}

export interface ExternalRef {
  url: string;
  kind: 'resource' | 'stylesheet' | 'link';
  blocked: boolean;
}

export interface RenderPlan {
  messageId: string;
  client: string;
  renderToken: number;
  body: {
    partId: string;
    mediaType: string;
    html: string; // ready for a sandboxed iframe srcdoc
    derivedFromHtml: boolean;
  } | null;
  resources: ResourceEntry[];
  missingResources: Array<{ cid: string }>;
  attachments: AttachmentEntry[];
  externalRefs: ExternalRef[];
  diagnostics: RenderDiagnostic[];
}

interface Selection {
  body: MimePart;
  chain: Set<MimePart>; // every part on the path to the body
  relatedResources: MimePart[]; // non-root children of selected related branches
}

function isDisplayableLeaf(part: MimePart): boolean {
  return part.contentType === 'text/plain' || part.contentType === 'text/html';
}

// Recursive branch selection. multipart/alternative prefers html (or text for
// plain clients) but falls back to whatever sibling branch is displayable, so
// a corrupted branch never blanks the message.
function selectBody(part: MimePart, preferHtml: boolean): Selection | null {
  if (part.contentType === 'multipart/alternative') {
    const ordered = preferHtml ? [...part.children].reverse() : part.children;
    for (const child of ordered) {
      const selection = selectBody(child, preferHtml);
      if (selection) {
        selection.chain.add(part);
        return selection;
      }
    }
    return null;
  }
  if (part.contentType === 'multipart/related') {
    if (part.children.length === 0) return null;
    const start = parseStartParam(part);
    const rootChild = (start && part.children.find((c) => c.contentId?.toLowerCase() === start)) || part.children[0];
    const selection = selectBody(rootChild, preferHtml);
    if (!selection) return null;
    selection.chain.add(part);
    for (const child of part.children) {
      if (child !== rootChild) selection.relatedResources.push(child);
    }
    return selection;
  }
  if (part.contentType.startsWith('multipart/')) {
    for (const child of part.children) {
      const selection = selectBody(child, preferHtml);
      if (selection) {
        selection.chain.add(part);
        return selection;
      }
    }
    return null;
  }
  if (isDisplayableLeaf(part)) {
    return { body: part, chain: new Set([part]), relatedResources: [] };
  }
  return null;
}

function parseStartParam(part: MimePart): string | null {
  const header = part.headers['content-type'];
  if (!header) return null;
  const match = header.match(/start\s*=\s*"?<?([^";>\s]+)>?"?/i);
  return match ? match[1].toLowerCase() : null;
}

// Collects attachment leaves: anything visible that is not the body, not a
// related resource, and not inside a rejected alternative branch.
function collectAttachments(root: MimePart, selection: Selection | null): MimePart[] {
  const resourceSet = new Set(selection?.relatedResources ?? []);
  const attachments: MimePart[] = [];
  const walk = (part: MimePart, visible: boolean) => {
    if (!visible) return;
    if (part.contentType === 'multipart/alternative') {
      // Only the selected alternative branch stays visible; rejected siblings
      // are alternatives, not attachments.
      for (const child of part.children) walk(child, selection !== null && selection.chain.has(child));
      return;
    }
    if (part.contentType.startsWith('multipart/')) {
      for (const child of part.children) walk(child, true);
      return;
    }
    if (selection && selection.chain.has(part)) return; // the body itself
    if (resourceSet.has(part)) return; // rendered as an inline resource
    attachments.push(part);
  };
  walk(root, true);
  return attachments;
}

const PLACEHOLDER_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return text.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (whole, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return named[entity.toLowerCase()] ?? whole;
  });
}

export function htmlToText(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  text = decodeEntities(text);
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

interface RewriteContext {
  messageId: string;
  cidIndex: Map<string, MimePart[]>;
  profile: ClientProfile;
  diagnostics: RenderDiagnostic[];
  externalRefs: ExternalRef[];
  referencedCids: Set<string>;
  missingCids: Set<string>;
}

function resolveCid(ctx: RewriteContext, cidRaw: string): string {
  let cid = cidRaw;
  try {
    cid = decodeURIComponent(cidRaw);
  } catch {
    /* keep raw */
  }
  const key = cid.trim().toLowerCase();
  const hit = ctx.cidIndex.get(key);
  if (hit && hit.length > 0) {
    ctx.referencedCids.add(key);
    return `/api/messages/${ctx.messageId}/resources/${hit[0].id}`;
  }
  ctx.missingCids.add(key);
  return '#missing-resource';
}

// Rewrites the selected HTML for a sandboxed iframe: cid: URLs become
// same-message proxy URLs, unknown external subresources are blocked unless
// the client profile allows them, and active content is stripped per profile.
export function rewriteHtml(html: string, ctx: RewriteContext): string {
  let out = html;

  if (ctx.profile.sanitize) {
    let removed = 0;
    out = out.replace(/<(script|form|iframe|object|embed)\b[\s\S]*?<\/\1>/gi, () => (removed++, ''));
    out = out.replace(/<(script|form|iframe|object|embed)\b[^>]*\/?>/gi, () => (removed++, ''));
    out = out.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, () => (removed++, ''));
    out = out.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, () => (removed++, ''));
    if (removed > 0) {
      ctx.diagnostics.push({
        partId: null,
        level: 'info',
        code: 'sanitized',
        message: `Client profile "${ctx.profile.id}" stripped ${removed} active element(s)/attribute(s).`,
      });
    }
  }

  // External stylesheets: recorded and dropped unless the profile loads remote.
  out = out.replace(/<link\b[^>]*>/gi, (tag) => {
    const href = tag.match(/href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const url = href?.[1] ?? href?.[2] ?? href?.[3] ?? '';
    if (/^https?:/i.test(url)) {
      ctx.externalRefs.push({ url, kind: 'stylesheet', blocked: !ctx.profile.loadRemote });
      return ctx.profile.loadRemote ? tag : '';
    }
    return tag;
  });

  // Anchor targets are recorded as external links; the sandboxed iframe keeps
  // them from navigating the host page, so nothing unknown loads by default.
  out = out.replace(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi, (tag, dq, sq, bare) => {
    const url = (dq ?? sq ?? bare ?? '') as string;
    if (/^https?:/i.test(url)) ctx.externalRefs.push({ url, kind: 'link', blocked: true });
    return tag;
  });

  // src=/background= attributes: cid: -> proxy, http(s): -> blocked placeholder.
  out = out.replace(
    /\b(src|background)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (whole, attr: string, dq, sq, bare) => {
      const url = (dq ?? sq ?? bare ?? '') as string;
      if (/^cid:/i.test(url)) return `${attr}="${resolveCid(ctx, url.slice(4))}"`;
      if (/^https?:/i.test(url)) {
        ctx.externalRefs.push({ url, kind: 'resource', blocked: !ctx.profile.loadRemote });
        if (!ctx.profile.loadRemote) return `${attr}="${PLACEHOLDER_PIXEL}"`;
      }
      return whole;
    },
  );

  // url(...) inside style attributes and <style> blocks.
  out = out.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (whole, _quote, url: string) => {
    if (/^cid:/i.test(url)) return `url("${resolveCid(ctx, url.slice(4))}")`;
    if (/^https?:/i.test(url)) {
      ctx.externalRefs.push({ url, kind: 'resource', blocked: !ctx.profile.loadRemote });
      if (!ctx.profile.loadRemote) return 'url("about:blank")';
    }
    return whole;
  });

  return out;
}

function wrapDocument(inner: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{font-family:system-ui,sans-serif;margin:12px}img{max-width:100%}pre{white-space:pre-wrap;font-family:ui-monospace,monospace}</style></head><body>${inner}</body></html>`;
}

function collectDiagnostics(root: MimePart): RenderDiagnostic[] {
  const out: RenderDiagnostic[] = [];
  const walk = (part: MimePart) => {
    for (const d of part.diagnostics) out.push({ ...d, partId: part.id });
    part.children.forEach(walk);
  };
  walk(root);
  return out;
}

export function buildRenderPlan(parsed: ParsedMessage, messageId: string, profile: ClientProfile, renderToken: number): RenderPlan {
  const diagnostics = collectDiagnostics(parsed.root);
  const externalRefs: ExternalRef[] = [];
  const missingResources: Array<{ cid: string }> = [];
  const resources: ResourceEntry[] = [];

  const selection = selectBody(parsed.root, profile.preferHtml);

  let body: RenderPlan['body'] = null;
  if (!selection) {
    diagnostics.push({
      partId: parsed.root.id,
      level: 'error',
      code: 'no_displayable_body',
      message: 'No displayable text branch found for this client profile.',
    });
  } else {
    const ctx: RewriteContext = {
      messageId,
      cidIndex: parsed.cidIndex,
      profile,
      diagnostics,
      externalRefs,
      referencedCids: new Set(),
      missingCids: new Set(),
    };

    const isHtml = selection.body.contentType === 'text/html';
    const decoded = decodeText(selection.body);
    let derivedFromHtml = false;
    let inner: string;

    if (isHtml && profile.preferHtml) {
      inner = rewriteHtml(decoded, ctx);
    } else if (isHtml) {
      // Plain-text client with an HTML-only branch: derive the fallback text.
      derivedFromHtml = true;
      diagnostics.push({
        partId: selection.body.id,
        level: 'info',
        code: 'html_as_text_fallback',
        message: 'Client prefers plain text; body derived from the HTML branch.',
      });
      inner = `<pre>${escapeHtml(htmlToText(decoded))}</pre>`;
    } else {
      inner = `<pre>${escapeHtml(decoded)}</pre>`;
    }

    for (const cid of ctx.missingCids) missingResources.push({ cid });

    // Resource map for the selected related branch(es); every part gets an
    // entry so duplicate Content-IDs stay visible instead of disappearing.
    for (const part of selection.relatedResources) {
      if (!part.contentId) {
        diagnostics.push({
          partId: part.id,
          level: 'info',
          code: 'resource_without_cid',
          message: 'Related part has no Content-ID and cannot be referenced from the body.',
        });
        continue;
      }
      const key = part.contentId.toLowerCase();
      const all = parsed.cidIndex.get(key) ?? [];
      const status: ResourceEntry['status'] = all.length > 1 && all[0] !== part ? 'duplicate' : ctx.referencedCids.has(key) ? 'ok' : 'unreferenced';
      resources.push({ cid: part.contentId, partId: part.id, status, proxyUrl: `/api/messages/${messageId}/resources/${part.id}` });
    }

    body = { partId: selection.body.id, mediaType: selection.body.contentType, html: wrapDocument(inner), derivedFromHtml };
  }

  // Attachments, with duplicate filenames disambiguated by part id.
  const attachmentParts = collectAttachments(parsed.root, selection);
  const nameCounts = new Map<string, number>();
  for (const part of attachmentParts) {
    const name = (part.filename ?? `part-${part.id}`).toLowerCase();
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  const attachments: AttachmentEntry[] = attachmentParts.map((part) => {
    const filename = part.filename ?? `part-${part.id}`;
    const duplicateName = (nameCounts.get(filename.toLowerCase()) ?? 0) > 1;
    if (duplicateName) {
      diagnostics.push({
        partId: part.id,
        level: 'warning',
        code: 'duplicate_attachment_name',
        message: `Attachment name "${filename}" is shared by multiple parts; use the part id to tell them apart.`,
      });
    }
    return {
      partId: part.id,
      filename,
      mediaType: part.contentType,
      size: decodeTransfer(part).length,
      duplicateName,
      downloadUrl: `/api/messages/${messageId}/resources/${part.id}?download=1`,
    };
  });

  return { messageId, client: profile.id, renderToken, body, resources, missingResources, attachments, externalRefs, diagnostics };
}
