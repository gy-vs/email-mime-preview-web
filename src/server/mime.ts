// MIME parser for the rendering lab.
//
// Design goals:
// - Preserve the *raw* part hierarchy: every node keeps its raw headers/body so
//   the UI can jump back from a render node to the original MIME part.
// - Never throw a parse error that blanks the whole message. Failures are
//   attached to the offending node as `error` and isolated to that branch.
// - Input is handled as latin1 so every byte round-trips for binary parts.

export type MimeError = {
  code:
    | 'malformed_part'
    | 'malformed_header'
    | 'unterminated_multipart'
    | 'empty_multipart'
    | 'unknown_transfer_encoding'
    | 'invalid_base64'
    | 'invalid_quoted_printable'
    | 'invalid_charset';
  message: string;
};

export type RawHeader = { name: string; value: string };

export type ContentType = {
  type: string; // lower-cased full media type, e.g. "text/html"; "" when missing
  params: Record<string, string>;
};

export type MimePart = {
  id: string; // dotted path from the root, e.g. "p0.2.1"
  contentType: ContentType;
  disposition: { type: string; params: Record<string, string> } | null;
  headers: RawHeader[];
  cid: string | null; // Content-ID with angle brackets stripped, raw
  contentLocation: string | null;
  /** leaf parts only: undecoded body in latin1 */
  rawBody?: string;
  /** multipart parts only */
  boundary?: string;
  children?: MimePart[];
  /** body size after transfer encoding decode (filled by analyzePart) */
  decodedSize?: number;
  /** set when this branch could not be fully parsed/rendered */
  error?: MimeError;
  /** raw text of the whole part (headers+body), for the part inspector */
  rawSource: string;
};

export type MimeTree = {
  root: MimePart;
  errors: { partId: string; code: string; message: string }[];
  /** content-ids seen more than once anywhere in the message */
  duplicateCids: string[];
  /** attachment filenames seen more than once anywhere in the message */
  duplicateAttachmentNames: string[];
};

const CRLF = '\r\n';

// ---------------------------------------------------------------------------
// low level helpers
// ---------------------------------------------------------------------------

/** Decode an RFC 2047 encoded-word (=?utf-8?B?...?=) when present. */
export function decodeEncodedWords(input: string): string {
  return input.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (whole, charset: string, enc: string, text: string) => {
      try {
        let bytes: Uint8Array;
        if (enc.toLowerCase() === 'b') {
          bytes = binaryStringToBytes(atobBase64(text));
        } else {
          bytes = binaryStringToBytes(decodeQpTokens(text, '_' ));
        }
        return decodeBytes(bytes, charset);
      } catch {
        return whole;
      }
    },
  );
}

function atobBase64(text: string): string {
  return Buffer.from(text.replace(/\s+/g, ''), 'base64').toString('latin1');
}

function binaryStringToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export function decodeBytes(bytes: Uint8Array, charset: string): string {
  const cs = (charset || 'utf-8').toLowerCase();
  try {
    return new TextDecoder(cs as string, { fatal: false }).decode(bytes);
  } catch {
    // latin1 always succeeds
    return new TextDecoder('latin1').decode(bytes);
  }
}

/** Parse "text/html; charset=utf-8" style header values. */
export function parseHeaderValue(raw: string): { value: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  const segments = splitParameters(raw);
  const value = (segments.shift() ?? '').trim().toLowerCase();
  for (const seg of segments) {
    const eq = seg.indexOf('=');
    if (eq < 0) continue;
    let key = seg.slice(0, eq).trim().toLowerCase();
    let val = seg.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    // RFC 5987 extended notation: name*=utf-8''%e2%82%ac
    if (key.endsWith('*')) {
      const m = /^([^']*)'([^']*)'(.*)$/s.exec(val);
      if (m) {
        key = key.slice(0, -1);
        try {
          val = decodeBytes(binaryStringToBytes(decodePercent(m[3])), m[1] || 'utf-8');
        } catch {
          /* keep raw */
        }
      }
    } else {
      val = decodeEncodedWords(val);
    }
    params[key] = val;
  }
  return { value, params };
}

function decodePercent(s: string): string {
  return s.replace(/%([0-9a-fA-F]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** Split a header value on top-level semicolons (respecting quoted strings). */
function splitParameters(raw: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      cur += ch;
      if (ch === quote && raw[i - 1] !== '\\') quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ';') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function getHeader(headers: RawHeader[], name: string): string | undefined {
  const lower = name.toLowerCase();
  const hit = headers.find((h) => h.name.toLowerCase() === lower);
  return hit?.value;
}

// ---------------------------------------------------------------------------
// transfer encoding
// ---------------------------------------------------------------------------

export type DecodedBody = { bytes: Uint8Array; error?: MimeError };

export function decodeTransferEncoding(part: MimePart): DecodedBody {
  const raw = part.rawBody ?? '';
  const cte = (getHeader(part.headers, 'content-transfer-encoding') ?? '7bit')
    .trim()
    .toLowerCase();
  switch (cte) {
    case '7bit':
    case '8bit':
    case 'binary':
    case '':
      return { bytes: binaryStringToBytes(stripLineEndings(raw)) };

    case 'base64': {
      // Base64 must only contain base64 alphabet, '=' and linear whitespace.
      const compact = raw.replace(/\s+/g, '');
      if (compact.length > 0 && !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
        return {
          bytes: binaryStringToBytes(Buffer.from(compact, 'base64').toString('latin1')),
          error: { code: 'invalid_base64', message: 'Part contains non-base64 characters' },
        };
      }
      return { bytes: binaryStringToBytes(Buffer.from(compact, 'base64').toString('latin1')) };
    }

    case 'quoted-printable': {
      const { text, error } = decodeQp(raw);
      return {
        bytes: binaryStringToBytes(text),
        error: error
          ? { code: 'invalid_quoted_printable', message: 'Malformed = escape sequence' }
          : undefined,
      };
    }

    default:
      return {
        bytes: binaryStringToBytes(stripLineEndings(raw)),
        error: {
          code: 'unknown_transfer_encoding',
          message: `Unsupported Content-Transfer-Encoding "${cte}"`,
        },
      };
  }
}

function stripLineEndings(raw: string): string {
  // 7bit/8bit bodies keep their content; normalize CRLF but preserve bytes.
  return raw.replace(/\r\n/g, '\n').replace(/\n$/, '');
}

/** decode quoted-printable, tracking invalid '=' escapes */
function decodeQp(raw: string): { text: string; error: boolean } {
  let error = false;
  // Soft line breaks first: "=" + CRLF disappears. A dangling "=" at EOF is
  // treated the same (common when the boundary CRLF is stripped).
  const s0 = raw.replace(/=\r?\n/g, '').replace(/=$/, '');
  let out = '';
  for (let i = 0; i < s0.length; i++) {
    const ch = s0[i];
    if (ch !== '=') {
      out += ch;
      continue;
    }
    const hex = s0.slice(i + 1, i + 3);
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      out += String.fromCharCode(parseInt(hex, 16));
      i += 2;
    } else {
      error = true;
      out += ch;
    }
  }
  return { text: out.replace(/\r\n/g, '\n').replace(/\n$/, ''), error };
}

// variant used for RFC 2047 Q-encoding (underscore = encoded space)
function decodeQpTokens(raw: string, spaceToken?: string): string {
  let s = raw.replace(/=([0-9A-Fa-f]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
  if (spaceToken) s = s.replace(/_/g, ' ');
  return s;
}

/** Decode a text part fully: transfer encoding + charset. */
export function decodeTextPart(part: MimePart): { text: string; error?: MimeError } {
  const { bytes, error } = decodeTransferEncoding(part);
  const charset = part.contentType.params.charset || 'utf-8';
  let text: string;
  let charsetError: MimeError | undefined;
  try {
    text = new TextDecoder(charset, { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder('latin1').decode(bytes);
    charsetError = {
      code: 'invalid_charset',
      message: `Unknown charset "${charset}", fell back to latin1`,
    };
  }
  return { text, error: error ?? charsetError };
}

// ---------------------------------------------------------------------------
// structural parsing
// ---------------------------------------------------------------------------

export function parseMime(rawInput: string): MimeTree {
  // Normalize line endings; keep every byte via latin1.
  const raw = rawInput.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let root: MimePart;
  try {
    root = parseEntity(raw, 'p0');
  } catch (err) {
    root = {
      id: 'p0',
      contentType: { type: 'application', params: {} },
      disposition: null,
      headers: [],
      cid: null,
      contentLocation: null,
      rawBody: raw,
      rawSource: raw,
      error: { code: 'malformed_part', message: (err as Error).message },
    };
  }

  const errors: MimeTree['errors'] = [];
  const cidSeen = new Map<string, number>();
  const nameSeen = new Map<string, number>();
  walk(root, (part) => {
    if (part.error) {
      errors.push({ partId: part.id, code: part.error.code, message: part.error.message });
    }
    if (part.cid) cidSeen.set(part.cid, (cidSeen.get(part.cid) ?? 0) + 1);
    const filename = attachmentName(part);
    if (filename) nameSeen.set(filename, (nameSeen.get(filename) ?? 0) + 1);
  });

  return {
    root,
    errors,
    duplicateCids: [...cidSeen].filter(([, n]) => n > 1).map(([cid]) => cid),
    duplicateAttachmentNames: [...nameSeen].filter(([, n]) => n > 1).map(([name]) => name),
  };
}

export function walk(part: MimePart, fn: (p: MimePart) => void): void {
  fn(part);
  part.children?.forEach((c) => walk(c, fn));
}

export function findPart(root: MimePart, id: string): MimePart | null {
  let found: MimePart | null = null;
  walk(root, (p) => {
    if (p.id === id) found = p;
  });
  return found;
}

export function partFileName(part: MimePart): string | null {
  return (
    part.disposition?.params.filename ||
    part.contentType.params.name ||
    null
  );
}

function attachmentName(part: MimePart): string | null {
  if (!part.disposition || part.disposition.type !== 'attachment') return null;
  return partFileName(part);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseEntity(source: string, id: string): MimePart {
  // Separate header block from body at the first blank line.
  const sep = source.match(/\n\n/);
  let headerBlock: string;
  let body = '';
  if (sep) {
    headerBlock = source.slice(0, sep.index);
    body = source.slice((sep.index ?? 0) + 2);
  } else if (!looksLikeHeaderBlock(source)) {
    // No blank line and the text does not look like a header block: a corrupt
    // blob sitting inside a boundary.
    return errorPart(id, source, {
      code: 'malformed_part',
      message: 'Part has no headers and no blank line separator',
    });
  } else {
    headerBlock = source;
  }

  const headers = parseHeaders(headerBlock);
  const ctRaw = getHeader(headers, 'content-type');
  const parsedCt = ctRaw ? parseHeaderValue(ctRaw) : null;
  const ct: ContentType = parsedCt
    ? { type: parsedCt.value, params: parsedCt.params }
    : { type: 'text/plain', params: {} };
  const dispRaw = getHeader(headers, 'content-disposition');
  const disposition = dispRaw ? parseHeaderValue(dispRaw) : null;
  const cidRaw = getHeader(headers, 'content-id');
  const cid = cidRaw ? cidRaw.trim().replace(/^<|>$/g, '').trim() : null;
  const contentLocation = getHeader(headers, 'content-location')?.trim() ?? null;

  const base: MimePart = {
    id,
    contentType: ct,
    disposition: disposition
      ? { type: disposition.value, params: disposition.params }
      : null,
    headers: headers.map((h) => ({ ...h })),
    cid,
    contentLocation,
    rawSource: source,
  };

  if (ct.type.startsWith('multipart/')) {
    const boundary = ct.params.boundary;
    if (!boundary) {
      return {
        ...base,
        boundary: undefined,
        error: { code: 'malformed_part', message: 'multipart part is missing a boundary' },
      };
    }
    return parseMultipart(base, body, boundary, id);
  }

  const leaf: MimePart = { ...base, rawBody: body };
  const decoded = decodeTransferEncoding(leaf);
  leaf.decodedSize = decoded.bytes.length;
  if (decoded.error) leaf.error = decoded.error;
  return leaf;
}

function errorPart(id: string, source: string, error: MimeError): MimePart {
  return {
    id,
    contentType: { type: '', params: {} },
    disposition: null,
    headers: [],
    cid: null,
    contentLocation: null,
    rawBody: source,
    rawSource: source,
    error,
  };
}

/**
 * A header block without a blank-line separator is only accepted when its
 * first line is a valid `token: value` header; otherwise the segment is a
 * corrupt blob (e.g. plain prose containing a colon).
 */
function looksLikeHeaderBlock(source: string): boolean {
  const firstLine = source.split('\n').find((l) => l.trim()) ?? '';
  return /^[\x21\x23-\x27\x2A\x2B\x2D\x2E\x30-\x39\x41-\x5A\x5E-\x7A\x7C\x7E]+:[ \t]*/.test(
    firstLine,
  );
}

function parseHeaders(block: string): RawHeader[] {
  const lines = block.split('\n');
  const unfolded: string[] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += ' ' + line.trim();
    } else {
      unfolded.push(line);
    }
  }
  const headers: RawHeader[] = [];
  for (const line of unfolded) {
    if (!line.trim()) continue;
    const colon = line.indexOf(':');
    if (colon < 0) {
      headers.push({ name: 'X-Mime-Lab-Error', value: `malformed header: ${line.trim()}` });
      continue;
    }
    headers.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() });
  }
  return headers;
}

function parseMultipart(base: MimePart, body: string, boundary: string, id: string): MimePart {
  const part: MimePart = { ...base, boundary, children: [] };
  const re = new RegExp(`(?:^|\\n)--${escapeRegExp(boundary)}(--)?[ \\t]*(?:\\n|$)`, 'g');

  const marks: { index: number; end: number; terminator: boolean }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    marks.push({ index: m.index, end: m.index + m[0].length, terminator: Boolean(m[1]) });
    if (m[1]) break;
  }

  if (marks.length === 0) {
    part.error = {
      code: 'malformed_part',
      message: `Boundary "${boundary}" never appears in the body`,
    };
    return part;
  }

  let terminated = false;
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i];
    if (mark.terminator) {
      terminated = true;
      break;
    }
    const next = marks[i + 1];
    let segment = next ? body.slice(mark.end, next.index) : body.slice(mark.end);
    // The CRLF immediately preceding a boundary belongs to the boundary (RFC 2046).
    segment = segment.replace(/\r?\n$/, '');
    if (!segment.trim()) continue; // empty / padding segment
    const childId = `${id}.${part.children!.length}`;
    try {
      part.children!.push(parseEntity(segment, childId));
    } catch (err) {
      part.children!.push(
        errorPart(childId, segment, {
          code: 'malformed_part',
          message: (err as Error).message,
        }),
      );
    }
  }

  if (!terminated) {
    part.error = {
      code: 'unterminated_multipart',
      message: `Boundary "${boundary}" has no closing "--${boundary}--" line`,
    };
  } else if (part.children!.length === 0) {
    part.error = { code: 'empty_multipart', message: 'Multipart body contains no parts' };
  }
  return part;
}

// ---------------------------------------------------------------------------
// JSON projection (drops potentially large raw fields)
// ---------------------------------------------------------------------------

export type PartSummary = {
  id: string;
  contentType: string;
  contentTypeParams: Record<string, string>;
  disposition: string | null;
  fileName: string | null;
  cid: string | null;
  contentLocation: string | null;
  encoding: string | null;
  size: number;
  isMultipart: boolean;
  childIds: string[];
  error: MimeError | null;
  headers: RawHeader[];
};

export function summarizePart(part: MimePart): PartSummary {
  return {
    id: part.id,
    contentType: part.contentType.type,
    contentTypeParams: part.contentType.params,
    disposition: part.disposition?.type ?? null,
    fileName: partFileName(part),
    cid: part.cid,
    contentLocation: part.contentLocation,
    encoding: getHeader(part.headers, 'content-transfer-encoding')?.trim() ?? null,
    size: part.decodedSize ?? part.rawBody?.length ?? 0,
    isMultipart: Boolean(part.children),
    childIds: part.children?.map((c) => c.id) ?? [],
    error: part.error ?? null,
    headers: part.headers,
  };
}

/** newline helper exported for sample builders */
export function crlf(text: string): string {
  return text.replace(/\r?\n/g, CRLF) + CRLF;
}
