// Client emulation: picks the displayable branch of a parsed MIME tree the way
// different mail clients would. No rendering happens here; this only decides
// *which parts* are shown and how resources may be referenced.

import {
  decodeTextPart,
  findPart,
  partFileName,
  walk,
  type MimePart,
  type MimeTree,
} from './mime.js';

export type ClientProfileId =
  | 'strict_html'
  | 'html_prefer_related'
  | 'text_only'
  | 'lenient_webmail';

export type ClientProfile = {
  id: ClientProfileId;
  label: string;
  description: string;
  /** choose text/plain even inside alternative */
  textOnly: boolean;
  /** load related resources referenced by cid/content-location */
  useRelated: boolean;
  /** show attachments inline (images without disposition) */
  inlineImages: boolean;
  /** load remote http(s) resources */
  allowRemote: boolean;
  /** keep going when an alternative branch is broken */
  lenient: boolean;
};

export const CLIENT_PROFILES: ClientProfile[] = [
  {
    id: 'strict_html',
    label: 'Strict desktop client',
    description: 'Best HTML alternative, related CIDs only, remote images blocked.',
    textOnly: false,
    useRelated: true,
    inlineImages: true,
    allowRemote: false,
    lenient: false,
  },
  {
    id: 'html_prefer_related',
    label: 'Modern webmail',
    description: 'HTML + related resources, remote images allowed after proxy.',
    textOnly: false,
    useRelated: true,
    inlineImages: true,
    allowRemote: true,
    lenient: true,
  },
  {
    id: 'text_only',
    label: 'Plain-text / terminal client',
    description: 'Never renders HTML; falls back to text/plain everywhere.',
    textOnly: true,
    useRelated: false,
    inlineImages: false,
    allowRemote: false,
    lenient: true,
  },
  {
    id: 'lenient_webmail',
    label: 'Lenient mobile client',
    description: 'Skips broken branches, shows inline images, remote blocked.',
    textOnly: false,
    useRelated: true,
    inlineImages: true,
    allowRemote: false,
    lenient: true,
  },
];

export function getProfile(id: string): ClientProfile {
  return CLIENT_PROFILES.find((p) => p.id === id) ?? CLIENT_PROFILES[0];
}

export type ResourceKind = 'cid' | 'content-location' | 'remote' | 'attachment';

export type ResourceRef = {
  /** raw reference as it appears in the HTML (cid:..., url, filename) */
  raw: string;
  kind: ResourceKind;
  /** resolved target part id, or null when nothing matches */
  targetPartId: string | null;
  /** why the resource will/will not load */
  status: 'ok' | 'blocked_remote' | 'not_found' | 'cross_message' | 'duplicate_cid';
  detail: string;
};

export type AttachmentInfo = {
  partId: string;
  fileName: string;
  contentType: string;
  size: number;
  /** another attachment in the same message uses the same name */
  nameCollision: boolean;
  error: boolean;
};

export type RenderNode = {
  /** stable key for the UI */
  key: string;
  kind: 'html' | 'text' | 'image-inline' | 'error' | 'empty';
  partId: string;
  label: string;
  /** rendered content for html/text nodes */
  content?: string;
  /** decode/branch warning carried into the node */
  warning?: string;
};

export type SelectionResult = {
  profileId: ClientProfileId;
  /** ordered list of nodes the client would display */
  nodes: RenderNode[];
  /** resources reachable from the displayed HTML */
  resources: ResourceRef[];
  attachments: AttachmentInfo[];
  /** global notes (duplicate CIDs, corrupt branches skipped, ...) */
  notices: string[];
};

// ---------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------

const isText = (p: MimePart, sub: string) => p.contentType.type === `text/${sub}`;
const isImage = (p: MimePart) => p.contentType.type.startsWith('image/');
const isAttachment = (p: MimePart) => p.disposition?.type === 'attachment';
const isInline = (p: MimePart) =>
  p.disposition === null || p.disposition.type === 'inline';

/**
 * Choose the display part for an entity according to the profile.
 * Returns the chosen part plus a trail of rejected alternatives.
 */
function chooseDisplay(
  part: MimePart,
  profile: ClientProfile,
): { chosen: MimePart | null; notice?: string } {
  if (part.error && part.children === undefined) {
    return { chosen: null, notice: `Part ${part.id} is unreadable: ${part.error.message}` };
  }

  const ct = part.contentType.type;

  if (ct === 'multipart/alternative') {
    return chooseAlternative(part, profile);
  }
  if (ct === 'multipart/related') {
    // The root part (start parameter or first child) is what renders; the
    // other children are resources. If that root is itself an alternative,
    // resolve it once here (not by feeding the related wrapper back into the
    // alternative ranker, which would mix up nesting levels).
    const kids = part.children ?? [];
    const startPart =
      (part.contentType.params.start &&
        kids.find((k) => k.cid === stripCid(part.contentType.params.start!))) ||
      kids[0];
    if (!startPart) return { chosen: null, notice: 'multipart/related has no root part' };
    if (startPart.contentType.type === 'multipart/alternative') {
      return chooseAlternative(startPart, profile);
    }
    return chooseDisplay(startPart, profile);
  }
  if (ct === 'multipart/mixed' || ct === 'multipart' || ct.startsWith('multipart/')) {
    // For display purposes the first non-attachment displayable child wins;
    // attachments are collected separately by the caller.
    for (const child of part.children ?? []) {
      if (isAttachment(child)) continue;
      const { chosen, notice } = chooseDisplay(child, profile);
      if (chosen) return { chosen };
      if (notice && profile.lenient === false) return { chosen: null, notice };
    }
    return { chosen: null };
  }

  // leaf entities
  if (profile.textOnly) {
    if (isText(part, 'plain')) return { chosen: part };
    if (isText(part, 'html')) {
      // text-only clients show tags stripped as a crude fallback is NOT done
      // here; instead we report the branch as unsuitable.
      return { chosen: null, notice: `Part ${part.id} is HTML but client is text-only` };
    }
    return { chosen: null };
  }

  if (isText(part, 'html') || isText(part, 'plain')) return { chosen: part };
  if (profile.inlineImages && isImage(part) && isInline(part)) return { chosen: part };
  return { chosen: null };
}

function preferenceRank(p: MimePart, profile: ClientProfile): number {
  if (isText(p, 'plain')) return profile.textOnly ? 100 : 10;
  if (isText(p, 'html')) return profile.textOnly ? 5 : 50;
  if (isImage(p)) return 30;
  if (p.contentType.type === 'multipart/related') return 60;
  if (p.contentType.type === 'multipart/alternative') return 50;
  if (p.contentType.type.startsWith('multipart/')) return 40; // nested
  return 1;
}

/**
 * Rank an alternative child by what it *offers*, descending into nested
 * multiparts so that a `multipart/related` wrapping the HTML outranks a bare
 * text/plain sibling (ranking the chosen leaf would rank them as equals and
 * let plain text win).
 */
function branchPreference(part: MimePart, profile: ClientProfile): number {
  const own = preferenceRank(part, profile);
  const kids = part.children ?? [];
  if (kids.length === 0) return own;
  let best = own;
  for (const child of kids) {
    best = Math.max(best, branchPreference(child, profile));
  }
  return best;
}

function chooseAlternative(
  part: MimePart,
  profile: ClientProfile,
): { chosen: MimePart | null; notice?: string } {
  const kids = part.children ?? [];
  const broken: string[] = [];
  let best: MimePart | null = null;
  let bestRank = -1;
  for (const child of kids) {
    const { chosen, notice } = chooseDisplay(child, profile);
    if (!chosen) {
      if (notice) broken.push(notice);
      else if (child.error) broken.push(`Part ${child.id} unreadable: ${child.error.message}`);
      continue;
    }
    const rank = branchPreference(child, profile);
    if (rank > bestRank) {
      best = chosen;
      bestRank = rank;
    }
  }

  if (best) {
    // If the top-ranked branch (html for an html-capable client) was broken
    // we already skipped it, so a fallback here is the correct degradation.
    if (broken.length > 0) {
      return { chosen: best, notice: `Fell back past: ${broken.join('; ')}` };
    }
    return { chosen: best };
  }

  if (broken.length > 0 && !profile.lenient) {
    return { chosen: null, notice: `All alternatives failed: ${broken.join('; ')}` };
  }
  // last-resort plain text: scan for any text/plain anywhere in the branch
  const fallback = findTextPlainDeep(part);
  if (fallback) return { chosen: fallback, notice: 'Used nested text/plain fallback' };
  return { chosen: null, notice: broken.join('; ') || 'multipart/alternative had no usable parts' };
}

function findTextPlainDeep(part: MimePart): MimePart | null {
  if (isText(part, 'plain') && !part.error) return part;
  for (const c of part.children ?? []) {
    const hit = findTextPlainDeep(c);
    if (hit) return hit;
  }
  return null;
}

function stripCid(ref: string): string {
  return ref.trim().replace(/^cid:/i, '').replace(/^<|>$/g, '').trim();
}

// ---------------------------------------------------------------------------
// resource analysis (related containment enforcement lives here)
// ---------------------------------------------------------------------------

const REF_PATTERN =
  /(?:src|href|poster)\s*=\s*"(?:cid:|https?:|\/|[\w.+-]+:)?[^"]*"|(?:src|href|poster)\s*=\s*'[^']*'|url\(\s*(?:'|")?[^)'"]+(?:'|")?\s*\)/gi;

function extractRefs(html: string): { raw: string; attr: string }[] {
  const out: { raw: string; attr: string }[] = [];
  for (const m of html.matchAll(REF_PATTERN)) {
    const token = m[0];
    const attrMatch = /^(src|href|poster)/i.exec(token);
    let raw: string;
    if (token.toLowerCase().startsWith('url(')) {
      raw = token.replace(/^url\(\s*['"]?|['"]?\s*\)$/gi, '');
    } else {
      const q = token.indexOf('"') >= 0 ? '"' : "'";
      const start = token.indexOf(q) + 1;
      const end = token.lastIndexOf(q);
      raw = token.slice(start, end > start ? end : token.length);
    }
    out.push({ raw: raw.trim(), attr: attrMatch?.[1].toLowerCase() ?? 'style' });
  }
  return out;
}

/**
 * Collect the set of parts that are "in scope" as related resources for the
 * displayed root: siblings inside the enclosing multipart/related.
 * Resources outside that container must never resolve (cross-message guard).
 */
function relatedScope(root: MimePart, displayPartId: string): {
  cidMap: Map<string, MimePart[]>;
  locMap: Map<string, MimePart>;
  container: MimePart | null;
} {
  const holder: { container: MimePart | null } = { container: null };
  walk(root, (p) => {
    if (
      p.contentType.type === 'multipart/related' &&
      (p.children ?? []).some((c) => containsPart(c, displayPartId))
    ) {
      holder.container = p;
    }
  });
  const cidMap = new Map<string, MimePart[]>();
  const locMap = new Map<string, MimePart>();
  const container = holder.container;
  if (container) {
    for (const child of container.children ?? []) {
      walk(child, (p) => {
        if (p.cid) {
          const list = cidMap.get(p.cid) ?? [];
          list.push(p);
          cidMap.set(p.cid, list);
        }
        if (p.contentLocation) locMap.set(normalizeLocation(p.contentLocation), p);
      });
    }
  }
  return { cidMap, locMap, container };
}

function containsPart(part: MimePart, id: string): boolean {
  let hit = false;
  walk(part, (p) => {
    if (p.id === id) hit = true;
  });
  return hit;
}

function normalizeLocation(loc: string): string {
  return loc.trim().replace(/^cid:/i, '').replace(/^<|>$/g, '');
}

// ---------------------------------------------------------------------------
// top-level selection
// ---------------------------------------------------------------------------

export function selectForClient(tree: MimeTree, profileId: string): SelectionResult {
  const profile = getProfile(profileId);
  const notices: string[] = [];
  const { chosen, notice } = chooseDisplay(tree.root, profile);
  if (notice) notices.push(notice);

  const nodes: RenderNode[] = [];
  const resources: ResourceRef[] = [];

  if (chosen) {
    buildNode(chosen, profile, tree, nodes, resources, notices);
  } else {
    nodes.push({
      key: 'none',
      kind: 'empty',
      partId: tree.root.id,
      label: 'No displayable content for this client profile',
      warning: notices.join('; ') || undefined,
    });
  }

  if (tree.duplicateCids.length > 0) {
    notices.push(
      `Duplicate Content-ID in message: ${tree.duplicateCids.map((c) => `<${c}>`).join(', ')} — references resolve to the first match`,
    );
  }

  const attachments = collectAttachments(tree);
  if (tree.duplicateAttachmentNames.length > 0) {
    notices.push(
      `Attachment filename collision: ${tree.duplicateAttachmentNames.join(', ')}`,
    );
  }

  // Surface corrupt branches anywhere so the user sees why a branch is missing,
  // while still rendering the rest of the message.
  walk(tree.root, (p) => {
    if (p.error && !nodes.some((n) => n.partId === p.id)) {
      notices.push(`Part ${p.id} (${p.contentType.type || 'unknown'}) parse error: ${p.error!.message}`);
    }
  });

  return { profileId: profile.id, nodes, resources, attachments, notices };
}

function buildNode(
  part: MimePart,
  profile: ClientProfile,
  tree: MimeTree,
  nodes: RenderNode[],
  resources: ResourceRef[],
  notices: string[],
): void {
  if (part.error) {
    nodes.push({
      key: part.id,
      kind: 'error',
      partId: part.id,
      label: `Broken part ${part.id}`,
      warning: part.error.message,
    });
    return;
  }

  if (isText(part, 'html') && !profile.textOnly) {
    const { text, error } = decodeTextPart(part);
    if (error) notices.push(`Part ${part.id}: ${error.message}`);
    nodes.push({
      key: part.id,
      kind: 'html',
      partId: part.id,
      label: 'HTML body',
      content: text,
      warning: error?.message,
    });
    if (profile.useRelated) {
      resources.push(...analyzeHtmlRefs(text, tree, part.id, profile));
    } else {
      resources.push(...analyzeHtmlRefs(text, tree, part.id, { ...profile, useRelated: false }));
    }
    return;
  }

  if (isText(part, 'plain')) {
    const { text, error } = decodeTextPart(part);
    if (error) notices.push(`Part ${part.id}: ${error.message}`);
    nodes.push({
      key: part.id,
      kind: 'text',
      partId: part.id,
      label: 'Plain text body',
      content: text,
      warning: error?.message,
    });
    return;
  }

  if (isImage(part) && isInline(part) && profile.inlineImages) {
    nodes.push({ key: part.id, kind: 'image-inline', partId: part.id, label: partFileName(part) ?? 'inline image' });
    return;
  }

  nodes.push({
    key: part.id,
    kind: 'empty',
    partId: part.id,
    label: `Part ${part.id} (${part.contentType.type}) not rendered by this client`,
  });
}

function analyzeHtmlRefs(
  html: string,
  tree: MimeTree,
  displayPartId: string,
  profile: ClientProfile,
): ResourceRef[] {
  const { cidMap, locMap, container } = relatedScope(tree.root, displayPartId);
  const globalCids = new Set<string>();
  walk(tree.root, (p) => {
    if (p.cid) globalCids.add(p.cid);
  });
  const refs = extractRefs(html);
  const seen = new Set<string>();
  const out: ResourceRef[] = [];

  for (const { raw } of refs) {
    if (!raw || raw.startsWith('#') || seen.has(raw)) continue;
    seen.add(raw);

    const lower = raw.toLowerCase();
    if (lower.startsWith('cid:')) {
      const cid = stripCid(raw);
      const matches = cidMap.get(cid) ?? [];
      if (!profile.useRelated) {
        out.push({ raw, kind: 'cid', targetPartId: null, status: 'cross_message', detail: 'Related resources disabled for this client' });
      } else if (!container) {
        out.push({ raw, kind: 'cid', targetPartId: null, status: 'cross_message', detail: 'No enclosing multipart/related: CID reference blocked' });
      } else if (matches.length === 0) {
        if (globalCids.has(cid)) {
          out.push({ raw, kind: 'cid', targetPartId: null, status: 'cross_message', detail: `Content-ID <${cid}> exists in the message but outside this related group; cross-group reference blocked` });
        } else {
          out.push({ raw, kind: 'cid', targetPartId: null, status: 'not_found', detail: `Content-ID <${cid}> not found inside the related group` });
        }
      } else if (matches.length > 1 || tree.duplicateCids.includes(cid)) {
        out.push({ raw, kind: 'cid', targetPartId: matches[0].id, status: 'duplicate_cid', detail: `${matches.length} parts share <${cid}>; using the first (${matches[0].id})` });
      } else {
        out.push({ raw, kind: 'cid', targetPartId: matches[0].id, status: 'ok', detail: `Resolved inside related group (${matches[0].id})` });
      }
      continue;
    }

    if (/^https?:\/\//i.test(raw) || /^\/\//.test(raw)) {
      // Remote content is never "related"; it is blocked by default and only
      // ever loaded through the proxy when the profile allows it.
      out.push({
        raw,
        kind: 'remote',
        targetPartId: null,
        status: profile.allowRemote ? 'ok' : 'blocked_remote',
        detail: profile.allowRemote
          ? 'Loaded through the sanitizing proxy'
          : 'Remote URL blocked by client policy (default)',
      });
      continue;
    }

    // bare relative reference -> may match Content-Location inside scope
    const locMatch = locMap.get(normalizeLocation(raw));
    if (locMatch && profile.useRelated) {
      out.push({ raw, kind: 'content-location', targetPartId: locMatch.id, status: 'ok', detail: `Matched Content-Location in related group (${locMatch.id})` });
    } else if (container && locMatch && !profile.useRelated) {
      out.push({ raw, kind: 'content-location', targetPartId: null, status: 'cross_message', detail: 'Related resources disabled for this client' });
    } else {
      out.push({ raw, kind: 'remote', targetPartId: null, status: 'blocked_remote', detail: 'Unknown/relative external reference; not loaded by default' });
    }
  }
  return out;
}

function collectAttachments(tree: MimeTree): AttachmentInfo[] {
  const out: AttachmentInfo[] = [];
  walk(tree.root, (p) => {
    if (isAttachment(p)) {
      const name = partFileName(p) ?? `${p.contentType.type || 'attachment'}-${p.id}`;
      out.push({
        partId: p.id,
        fileName: name,
        contentType: p.contentType.type || 'application/octet-stream',
        size: p.decodedSize ?? p.rawBody?.length ?? 0,
        nameCollision: tree.duplicateAttachmentNames.includes(name),
        error: Boolean(p.error),
      });
    }
  });
  return out;
}

export { findPart };
