// MIME parsing: keeps the original part hierarchy, Content-IDs and transfer
// encodings. Parse problems are recorded as diagnostics on the part that
// caused them, never thrown, so one broken branch cannot blank the message.

export type DiagnosticLevel = 'error' | 'warning' | 'info';

export interface PartDiagnostic {
  level: DiagnosticLevel;
  code: string;
  message: string;
}

export interface MimePart {
  id: string; // dotted path: "1", "1.2", "1.2.1"
  headers: Record<string, string>; // lower-cased header name -> unfolded value
  contentType: string; // lower-cased type/subtype
  charset: string | null;
  boundary: string | null;
  transferEncoding: string; // lower-cased
  contentId: string | null; // normalized, without < >
  disposition: string; // 'attachment' | 'inline' | ''
  filename: string | null;
  children: MimePart[];
  rawBody: string; // undecoded body exactly as imported
  diagnostics: PartDiagnostic[];
}

export interface ParsedMessage {
  root: MimePart;
  partIndex: Map<string, MimePart>;
  cidIndex: Map<string, MimePart[]>; // normalized cid -> parts, first wins
}

const MAX_DEPTH = 25;

function unfoldHeaders(block: string): string[] {
  const lines = block.split(/\r?\n/);
  const unfolded: string[] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += ' ' + line.trim();
    } else if (line.trim() !== '') {
      unfolded.push(line);
    }
  }
  return unfolded;
}

function parseHeaders(block: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of unfoldHeaders(block)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name) headers[name] = value;
  }
  return headers;
}

// Splits "text/html; charset=\"utf-8\"" into value + params, respecting quotes.
export function parseParams(headerValue: string): { value: string; params: Record<string, string> } {
  const segments: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of headerValue) {
    if (ch === '"') quoted = !quoted;
    if (ch === ';' && !quoted) {
      segments.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  segments.push(current);
  const value = (segments.shift() ?? '').trim().toLowerCase();
  const params: Record<string, string> = {};
  for (const segment of segments) {
    const eq = segment.indexOf('=');
    if (eq <= 0) continue;
    const key = segment.slice(0, eq).trim().toLowerCase();
    let param = segment.slice(eq + 1).trim();
    if (param.startsWith('"') && param.endsWith('"') && param.length >= 2) {
      param = param.slice(1, -1);
    }
    if (key) params[key] = param;
  }
  return { value, params };
}

// Minimal RFC 2047 encoded-word decoding for filenames (=?UTF-8?B?...?= / ?Q?).
export function decodeEncodedWords(input: string): string {
  return input.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, _charset, enc: string, text: string) => {
    try {
      if (enc.toUpperCase() === 'B') return Buffer.from(text, 'base64').toString('utf8');
      const bytes: number[] = [];
      for (let i = 0; i < text.length; i++) {
        if (text[i] === '_') bytes.push(0x20);
        else if (text[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
          bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
          i += 2;
        } else bytes.push(text.charCodeAt(i) & 0xff);
      }
      return Buffer.from(bytes).toString('utf8');
    } catch {
      return whole;
    }
  });
}

function normalizeContentId(header: string | undefined): string | null {
  if (!header) return null;
  const trimmed = header.trim().replace(/^<|>$/g, '').trim();
  return trimmed === '' ? null : trimmed;
}

interface SplitResult {
  parts: string[];
  closed: boolean;
}

function splitByBoundary(body: string, boundary: string): SplitResult {
  const delimiter = '--' + boundary;
  const parts: string[] = [];
  let current: string[] | null = null;
  let closed = false;
  for (const line of body.split(/\r?\n/)) {
    if (line === delimiter || line.startsWith(delimiter + ' ')) {
      if (current !== null) parts.push(current.join('\n'));
      current = [];
    } else if (line === delimiter + '--' || line.startsWith(delimiter + '--')) {
      if (current !== null) parts.push(current.join('\n'));
      current = null;
      closed = true;
      break; // everything after the closing delimiter is epilogue
    } else if (current !== null) {
      current.push(line);
    }
    // lines before the first delimiter are preamble and ignored
  }
  if (!closed && current !== null) parts.push(current.join('\n'));
  return { parts: parts.filter((p) => p.trim() !== ''), closed };
}

const KNOWN_ENCODINGS = new Set(['7bit', '8bit', 'binary', 'base64', 'quoted-printable']);

function parsePart(block: string, id: string, depth: number): MimePart {
  const diagnostics: PartDiagnostic[] = [];
  const separator = block.match(/\r?\n\r?\n/);
  let headerBlock = '';
  let body = block;
  if (separator && separator.index !== undefined) {
    headerBlock = block.slice(0, separator.index);
    body = block.slice(separator.index + separator[0].length);
  } else if (block.trim() !== '') {
    diagnostics.push({
      level: 'error',
      code: 'missing_header_separator',
      message: 'No header/body separator found; treating the whole block as a text/plain body.',
    });
  }

  const headers = parseHeaders(headerBlock);

  const typeHeader = headers['content-type'];
  const parsedType = typeHeader ? parseParams(typeHeader) : { value: '', params: {} };
  let contentType = parsedType.value || 'text/plain';
  if (!/^[-\w.+]+\/[-\w.+]+$/.test(contentType)) {
    diagnostics.push({
      level: 'warning',
      code: 'invalid_content_type',
      message: `Unparseable Content-Type "${typeHeader ?? ''}"; assuming text/plain.`,
    });
    contentType = 'text/plain';
  }

  const rawEncoding = (headers['content-transfer-encoding'] ?? '7bit').trim().toLowerCase();
  let transferEncoding = rawEncoding;
  if (!KNOWN_ENCODINGS.has(rawEncoding)) {
    diagnostics.push({
      level: 'warning',
      code: 'unknown_transfer_encoding',
      message: `Unknown Content-Transfer-Encoding "${rawEncoding}"; treating body as 8bit.`,
    });
    transferEncoding = '8bit';
  }

  const dispositionHeader = headers['content-disposition'];
  const parsedDisposition = dispositionHeader ? parseParams(dispositionHeader) : { value: '', params: {} };

  let filename: string | null = null;
  const rawFilename = parsedDisposition.params['filename'] ?? parsedType.params['name'];
  if (rawFilename) filename = decodeEncodedWords(rawFilename);

  const part: MimePart = {
    id,
    headers,
    contentType,
    charset: parsedType.params['charset'] ?? null,
    boundary: parsedType.params['boundary'] ?? null,
    transferEncoding,
    contentId: normalizeContentId(headers['content-id']),
    disposition: parsedDisposition.value === 'attachment' || parsedDisposition.value === 'inline' ? parsedDisposition.value : '',
    filename,
    children: [],
    rawBody: body,
    diagnostics,
  };

  if (contentType.startsWith('multipart/')) {
    if (depth >= MAX_DEPTH) {
      diagnostics.push({ level: 'error', code: 'max_depth', message: `Nesting deeper than ${MAX_DEPTH} levels; branch not expanded.` });
      return part;
    }
    if (!part.boundary) {
      diagnostics.push({
        level: 'error',
        code: 'missing_boundary',
        message: `Multipart part declares no boundary; its content cannot be split and is kept as raw text.`,
      });
      return part;
    }
    const { parts, closed } = splitByBoundary(body, part.boundary);
    if (!closed) {
      diagnostics.push({
        level: 'warning',
        code: 'unterminated_multipart',
        message: `Closing boundary "--${part.boundary}--" not found; parsed what was available.`,
      });
    }
    if (parts.length === 0) {
      diagnostics.push({ level: 'warning', code: 'empty_multipart', message: 'Multipart part contains no sub-parts.' });
    }
    part.children = parts.map((childBlock, index) => parsePart(childBlock, `${id}.${index + 1}`, depth + 1));
    return part;
  }

  if (transferEncoding === 'base64') {
    const compact = body.replace(/\s+/g, '');
    const invalid = compact.match(/[^A-Za-z0-9+/=]/g);
    if (invalid && invalid.length > 0) {
      diagnostics.push({
        level: 'warning',
        code: 'invalid_base64',
        message: `Base64 body contains ${invalid.length} invalid character(s); decoding best-effort.`,
      });
    }
  }

  return part;
}

export function parseMessage(raw: string): ParsedMessage {
  const root = parsePart(raw, '1', 0);
  const partIndex = new Map<string, MimePart>();
  const cidIndex = new Map<string, MimePart[]>();
  const walk = (part: MimePart) => {
    partIndex.set(part.id, part);
    if (part.contentId) {
      const key = part.contentId.toLowerCase();
      const list = cidIndex.get(key) ?? [];
      if (list.length > 0) {
        part.diagnostics.push({
          level: 'warning',
          code: 'duplicate_content_id',
          message: `Content-ID "${part.contentId}" is already used by part ${list[0].id}; references resolve to the first occurrence.`,
        });
      }
      list.push(part);
      cidIndex.set(key, list);
    }
    part.children.forEach(walk);
  };
  walk(root);
  return { root, partIndex, cidIndex };
}

export function decodeTransfer(part: MimePart): Buffer {
  if (part.transferEncoding === 'base64') {
    return Buffer.from(part.rawBody.replace(/\s+/g, ''), 'base64');
  }
  if (part.transferEncoding === 'quoted-printable') {
    const bytes: number[] = [];
    const input = part.rawBody;
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (ch === '=') {
        const hex = input.slice(i + 1, i + 3);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          bytes.push(parseInt(hex, 16));
          i += 2;
        } else if (input[i + 1] === '\r' && input[i + 2] === '\n') {
          i += 2;
        } else if (input[i + 1] === '\n') {
          i += 1;
        } else {
          bytes.push(0x3d);
        }
      } else {
        bytes.push(ch.charCodeAt(0) & 0xff);
      }
    }
    return Buffer.from(bytes);
  }
  return Buffer.from(part.rawBody, 'utf8');
}

export function decodeText(part: MimePart): string {
  const data = decodeTransfer(part);
  const charset = (part.charset ?? 'utf-8').toLowerCase();
  if (/latin1|iso-8859|windows-1252|us-ascii/.test(charset)) return data.toString('latin1');
  return data.toString('utf8');
}
