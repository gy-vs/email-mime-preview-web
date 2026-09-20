// Built-in sample messages. Every fixture deliberately exercises something
// real clients get wrong; see comments on each export.

import { crlf } from './mime.js';

// 1x1 transparent PNG
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
// 1x1 GIF
const GIF_1X1 = 'R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=';
// small JPEG-ish payload (only used as labelled bytes in this lab)
const JPEG_STUB =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AfwD/2Q==';

function base64Wrap(b64: string): string {
  return (b64.match(/.{1,76}/g) ?? []).join('\r\n');
}

/** Minimal valid quoted-printable encoder for fixture HTML. */
function qpEncode(s: string): string {
  const bytes = Buffer.from(s, 'utf8').toString('latin1');
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const code = bytes.charCodeAt(i);
    const ch = bytes[i];
    if (ch === '=') out += '=3D';
    else if (code === 32 && i === bytes.length - 1) out += '=20';
    else if (code === 9 || code >= 32 && code <= 126) out += ch;
    else out += '=' + code.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

export type Sample = { id: string; name: string; description: string; raw: string };

export const SAMPLES: Sample[] = [
  {
    id: 'newsletter',
    name: 'Newsletter (nested alt/related + remote + missing CID)',
    description:
      'multipart/mixed → alternative → (text/plain, related HTML+images). HTML references a present CID, a remote tracker (blocked by default) and a missing CID.',
    raw: buildNewsletter(),
  },
  {
    id: 'dupes',
    name: 'Duplicate CID + same-name attachments',
    description:
      'Two image parts share <pic@x> and two attachments are both named "notes.txt". Nested alternative inside related.',
    raw: buildDupes(),
  },
  {
    id: 'damaged',
    name: 'Damaged branches + plain-text fallback',
    description:
      'HTML alternative has an unknown transfer encoding, a child part has no headers, the multipart is unterminated, and a base64 attachment is corrupt.',
    raw: buildDamaged(),
  },
  {
    id: 'plain',
    name: 'Plain text only',
    description: 'No HTML at all; HTML-capable clients must render the text part.',
    raw: buildPlain(),
  },
  {
    id: 'crossmessage',
    name: 'CID defined outside the related group',
    description:
      'HTML references <logo@x> but the image carrying that CID lives in a sibling mixed section, not in multipart/related. Must not resolve.',
    raw: buildCrossMessage(),
  },
];

function headers(rows: [string, string][]): string {
  return crlf(rows.map(([k, v]) => `${k}: ${v}`).join('\r\n'));
}

function buildNewsletter(): string {
  const boundary = 'MIXED-BOUNDARY-1';
  const altB = 'ALT-BOUNDARY-1';
  const relB = 'RELATED-BOUNDARY-1';

  const html = [
    '<!doctype html><html><head><meta charset="utf-8"></head><body>',
    '<h1>Lab Newsletter — issue 1</h1>',
    '<p><img src="cid:logo@news" alt="logo" width="16" height="16"></p>',
    '<p>Inline hero:</p>',
    '<p><img src="cid:hero@news" alt="hero"></p>',
    '<p>Missing footer: <img src="cid:footer-nowhere@news" alt="missing"></p>',
    '<p>Remote tracker: <img src="https://tracker.example.invalid/pixel.gif" alt=""></p>',
    '<p>Bare relative: <img src="images/relative.png" alt=""></p>',
    '<p>Body copy below.</p>',
    '</body></html>',
  ].join('');
  // Real QP: literal '=' -> =3D; em dash (UTF-8 E2 80 94) -> =E2=80=94.
  const htmlQp = crlf(qpEncode(html));

  const text = crlf(
    'Lab Newsletter\r\n\r\nInline logo and hero attached as related images.\r\nA footer image is referenced but missing.\r\n',
  );

  const related = [
    `--${relB}`,
    headers([
      ['Content-Type', 'text/html; charset="utf-8"'],
      ['Content-Transfer-Encoding', 'quoted-printable'],
    ]),
    htmlQp,
    `--${relB}`,
    headers([
      ['Content-Type', 'image/png; name="logo.png"'],
      ['Content-Transfer-Encoding', 'base64'],
      ['Content-ID', '<logo@news>'],
      ['Content-Disposition', 'inline; filename="logo.png"'],
    ]),
    base64Wrap(PNG_1X1),
    '',
    `--${relB}`,
    headers([
      ['Content-Type', 'image/gif; name="hero.gif"'],
      ['Content-Transfer-Encoding', 'base64'],
      ['Content-ID', '<hero@news>'],
    ]),
    base64Wrap(GIF_1X1),
    '',
    `--${relB}--`,
    '',
  ].join('\r\n');

  const alternative = [
    `--${altB}`,
    headers([['Content-Type', 'text/plain; charset=utf-8']]),
    text,
    `--${altB}`,
    headers([['Content-Type', `multipart/related; boundary="${relB}"; type="text/html"`]]),
    related,
    `--${altB}--`,
    '',
  ].join('\r\n');

  return [
    headers([
      ['From', 'Lab <lab@example.invalid>'],
      ['To', 'You <you@example.invalid>'],
      ['Subject', '=?utf-8?B?TGFiIE5ld3NsZXR0ZXIgwrgg5pWZ6IKy?='],
      ['MIME-Version', '1.0'],
      ['Content-Type', `multipart/mixed; boundary="${boundary}"`],
    ]),
    `--${boundary}`,
    headers([['Content-Type', `multipart/alternative; boundary="${altB}"`]]),
    alternative,
    `--${boundary}`,
    headers([
      ['Content-Type', 'application/pdf; name="report.pdf"'],
      ['Content-Transfer-Encoding', 'base64'],
      ['Content-Disposition', 'attachment; filename="report.pdf"'],
    ]),
    base64Wrap('JVBERi0tMTogZmFrZSBsYWIgcGRm'),
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

function buildDupes(): string {
  const mixedB = 'DUP-MIXED';
  const relB = 'DUP-RELATED';
  const altB = 'DUP-ALT';

  const html = crlf(
    '<html><body><h1>Two parts share one CID</h1><img src="cid:pic@x" alt="pic"></body></html>',
  );
  const text = crlf('Two parts share one CID: <pic@x>.\r\n');

  const alternative = [
    `--${altB}`,
    headers([['Content-Type', 'text/plain; charset=utf-8']]),
    text,
    `--${altB}`,
    headers([['Content-Type', 'text/html; charset=utf-8']]),
    html,
    `--${altB}--`,
    '',
  ].join('\r\n');

  const related = [
    `--${relB}`,
    headers([['Content-Type', `multipart/alternative; boundary="${altB}"`]]),
    alternative,
    `--${relB}`,
    headers([
      ['Content-Type', 'image/jpeg; name="a.jpg"'],
      ['Content-Transfer-Encoding', 'base64'],
      ['Content-ID', '<pic@x>'],
    ]),
    base64Wrap(JPEG_STUB),
    '',
    `--${relB}`,
    headers([
      ['Content-Type', 'image/png; name="b.png"'],
      ['Content-Transfer-Encoding', 'base64'],
      ['Content-ID', '<pic@x>'],
    ]),
    base64Wrap(PNG_1X1),
    '',
    `--${relB}--`,
    '',
  ].join('\r\n');

  const notesOne = crlf('first notes.txt attachment');
  const notesTwo = crlf('second notes.txt attachment - same filename');

  return [
    headers([
      ['Subject', 'Duplicates'],
      ['MIME-Version', '1.0'],
      ['Content-Type', `multipart/mixed; boundary="${mixedB}"`],
    ]),
    `--${mixedB}`,
    headers([
      ['Content-Type', `multipart/related; boundary="${relB}"; type="multipart/alternative"`],
    ]),
    related,
    `--${mixedB}`,
    headers([
      ['Content-Type', 'text/plain; name="notes.txt"'],
      ['Content-Disposition', 'attachment; filename="notes.txt"'],
    ]),
    notesOne,
    `--${mixedB}`,
    headers([
      ['Content-Type', 'text/plain; name="notes.txt"'],
      ['Content-Disposition', 'attachment; filename="notes.txt"'],
      ['Content-Transfer-Encoding', '8bit'],
    ]),
    notesTwo,
    `--${mixedB}--`,
    '',
  ].join('\r\n');
}

function buildDamaged(): string {
  const mixedB = 'BROKEN-MIXED';
  const altB = 'BROKEN-ALT';

  // Deliberately NO closing "--BROKEN-MIXED--" (unterminated multipart).
  return [
    headers([
      ['Subject', 'Damaged'],
      ['MIME-Version', '1.0'],
      ['Content-Type', `multipart/mixed; boundary="${mixedB}"`],
    ]),
    `--${mixedB}`,
    headers([['Content-Type', `multipart/alternative; boundary="${altB}"`]]),
    `--${altB}`,
    headers([
      ['Content-Type', 'text/html; charset=utf-8'],
      // Not a valid CTE token: the branch must be flagged but isolated.
      ['Content-Transfer-Encoding', 'x-base64-garbage'],
    ]),
    crlf('<html><body>this is not @@@ valid base64</body></html>'),
    `--${altB}`,
    headers([['Content-Type', 'text/plain; charset=utf-8']]),
    crlf('Plain text fallback: the HTML branch was damaged.\r\n'),
    `--${altB}--`,
    '',
    `--${mixedB}`,
    // A raw blob with no headers and no blank line: a corrupt child part.
    'this part is just a blob with no headers at all',
    `--${mixedB}`,
    headers([
      ['Content-Type', 'application/octet-stream; name="broken.bin"'],
      ['Content-Disposition', 'attachment; filename="broken.bin"'],
      ['Content-Transfer-Encoding', 'base64'],
    ]),
    '@@@@not-base64@@@@',
    '',
  ].join('\r\n');
}

function buildPlain(): string {
  return [
    headers([
      ['Subject', 'Plain'],
      ['MIME-Version', '1.0'],
      ['Content-Type', 'text/plain; charset=utf-8'],
    ]),
    crlf('Just text.\r\nNo MIME tree, no HTML.\r\n'),
  ].join('\r\n');
}

function buildCrossMessage(): string {
  const mixedB = 'CROSS-MIXED';
  const relB = 'CROSS-RELATED';

  const html = crlf(
    '<html><body><h1>Cross-group CID</h1><img src="cid:logo@x" alt="logo"></body></html>',
  );

  // The related group contains only the HTML; the image with <logo@x> lives in
  // a *different* section of the same message. It must not resolve.
  const related = [
    `--${relB}`,
    headers([['Content-Type', 'text/html; charset=utf-8']]),
    html,
    `--${relB}--`,
    '',
  ].join('\r\n');

  return [
    headers([
      ['Subject', 'Cross-message CID'],
      ['MIME-Version', '1.0'],
      ['Content-Type', `multipart/mixed; boundary="${mixedB}"`],
    ]),
    `--${mixedB}`,
    headers([['Content-Type', `multipart/related; boundary="${relB}"; type="text/html"`]]),
    related,
    `--${mixedB}`,
    headers([
      ['Content-Type', 'image/png; name="logo.png"'],
      ['Content-Transfer-Encoding', 'base64'],
      ['Content-ID', '<logo@x>'],
      ['Content-Disposition', 'attachment; filename="logo.png"'],
    ]),
    base64Wrap(PNG_1X1),
    '',
    `--${mixedB}--`,
    '',
  ].join('\r\n');
}
