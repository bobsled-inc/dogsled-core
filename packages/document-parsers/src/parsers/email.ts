import type { DocumentParser, ParseOptions, ParseResult } from '../types.js';

import { htmlToText } from './html.js';
import { normalizeExtractedText } from './xml.js';

const PARSER_VERSION = 'eml:1.0.0';

interface HeaderBlock {
  readonly headers: Map<string, string[]>;
  readonly body: string;
}

interface TextParts {
  readonly plain: string[];
  readonly html: string[];
}

export const emailParser: DocumentParser = {
  format: 'eml',
  version: PARSER_VERSION,
  // Mbox support is intentionally omitted for v1: it requires splitting on `From `
  // separators and emitting one document per message. Until then, only single-message
  // RFC 5322 (.eml) streams are supported.
  supportedExtensions: ['eml'],
  async parse(input: Uint8Array, opts: ParseOptions): Promise<ParseResult> {
    if (opts.maxFileSizeBytes && input.byteLength > opts.maxFileSizeBytes) {
      return {
        status: 'error',
        format: 'eml',
        errorCode: 'file_too_large',
        message: `File ${input.byteLength} bytes exceeds max ${opts.maxFileSizeBytes}`,
        parserVersion: PARSER_VERSION,
      };
    }

    try {
      const raw = new TextDecoder('utf-8', { fatal: false }).decode(input);
      const root = splitHeaders(raw);
      const parts = extractTextParts(root);
      const text = normalizeExtractedText(
        (parts.plain.length > 0 ? parts.plain : parts.html).join('\n\n')
      );
      if (!text) {
        return {
          status: 'error',
          format: 'eml',
          errorCode: 'corrupt_input',
          message: 'Email did not include extractable text/plain or text/html content',
          parserVersion: PARSER_VERSION,
        };
      }
      return {
        status: 'parsed',
        format: 'eml',
        text,
        parserVersion: PARSER_VERSION,
        metadata: {
          byteLength: input.byteLength,
          subject: decodeMimeWords(firstHeader(root.headers, 'subject') ?? ''),
          from: decodeMimeWords(firstHeader(root.headers, 'from') ?? ''),
          to: decodeMimeWords(firstHeader(root.headers, 'to') ?? ''),
          date: firstHeader(root.headers, 'date') ?? null,
          messageId: firstHeader(root.headers, 'message-id') ?? null,
          contentType: firstHeader(root.headers, 'content-type') ?? 'text/plain',
        },
      };
    } catch (err) {
      return {
        status: 'error',
        format: 'eml',
        errorCode: 'corrupt_input',
        message: err instanceof Error ? err.message : String(err),
        parserVersion: PARSER_VERSION,
      };
    }
  },
};

function splitHeaders(raw: string): HeaderBlock {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const boundary = normalized.indexOf('\n\n');
  const headerText = boundary >= 0 ? normalized.slice(0, boundary) : '';
  const body = boundary >= 0 ? normalized.slice(boundary + 2) : normalized;
  const unfolded: string[] = [];
  for (const line of headerText.split('\n')) {
    if (/^[ \t]/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] = `${unfolded[unfolded.length - 1]} ${line.trim()}`;
    } else if (line.trim()) {
      unfolded.push(line);
    }
  }

  const headers = new Map<string, string[]>();
  for (const line of unfolded) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const values = headers.get(key) ?? [];
    values.push(value);
    headers.set(key, values);
  }
  return { headers, body };
}

function extractTextParts(block: HeaderBlock): TextParts {
  const contentType = parseParameterizedHeader(firstHeader(block.headers, 'content-type'));
  if (contentType.value.startsWith('multipart/')) {
    const boundary = contentType.params.get('boundary');
    if (!boundary) return { plain: [], html: [] };
    const out: TextParts = { plain: [], html: [] };
    for (const part of splitMultipartBody(block.body, boundary)) {
      const child = extractTextParts(splitHeaders(part));
      out.plain.push(...child.plain);
      out.html.push(...child.html);
    }
    return out;
  }

  if (contentType.value === 'message/rfc822') {
    return extractTextParts(splitHeaders(decodeBody(block.body, block.headers, contentType)));
  }

  const decoded = decodeBody(block.body, block.headers, contentType);
  if (contentType.value === 'text/html') {
    return { plain: [], html: [htmlToText(decoded)] };
  }
  if (contentType.value === 'text/plain' || !firstHeader(block.headers, 'content-type')) {
    return { plain: [decoded], html: [] };
  }
  return { plain: [], html: [] };
}

function splitMultipartBody(body: string, boundary: string): string[] {
  const marker = `--${boundary}`;
  return body
    .split(marker)
    .slice(1)
    .map((part) => part.replace(/^\n/, '').replace(/\n$/, ''))
    .filter((part) => !part.startsWith('--') && part.trim().length > 0);
}

function decodeBody(
  body: string,
  headers: Map<string, string[]>,
  contentType: { value: string; params: Map<string, string> }
): string {
  const encoding = (firstHeader(headers, 'content-transfer-encoding') ?? '7bit').toLowerCase();
  const charset = contentType.params.get('charset') ?? 'utf-8';
  if (encoding === 'base64') {
    return decodeBytes(Buffer.from(body.replace(/\s+/g, ''), 'base64'), charset);
  }
  if (encoding === 'quoted-printable') {
    return decodeBytes(decodeQuotedPrintable(body), charset);
  }
  return body;
}

function decodeQuotedPrintable(input: string): Uint8Array {
  const bytes: number[] = [];
  const normalized = input.replace(/=\r?\n/g, '');
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i]!;
    if (char === '=' && /^[0-9a-fA-F]{2}$/.test(normalized.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(normalized.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(normalized.charCodeAt(i) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

function decodeMimeWords(input: string): string {
  return input.replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (_m, charset, enc, text) => {
    if (String(enc).toUpperCase() === 'B') {
      return decodeBytes(Buffer.from(String(text), 'base64'), String(charset));
    }
    const q = String(text).replace(/_/g, ' ');
    return decodeBytes(decodeQuotedPrintable(q), String(charset));
  });
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

function firstHeader(headers: Map<string, string[]>, key: string): string | undefined {
  return headers.get(key.toLowerCase())?.[0];
}

function parseParameterizedHeader(value: string | undefined): {
  value: string;
  params: Map<string, string>;
} {
  if (!value) return { value: 'text/plain', params: new Map() };
  const [head, ...tail] = value.split(';');
  const params = new Map<string, string>();
  for (const raw of tail) {
    const equals = raw.indexOf('=');
    if (equals < 0) continue;
    const key = raw.slice(0, equals).trim().toLowerCase();
    const param = raw
      .slice(equals + 1)
      .trim()
      .replace(/^"|"$/g, '');
    params.set(key, param);
  }
  return { value: (head ?? 'text/plain').trim().toLowerCase(), params };
}
