import type { DocumentParser, ParseOptions, ParseResult } from '../types.js';

const PARSER_VERSION = 'html:1.0.1';

/**
 * Minimal HTML parser. Strips tags, decodes a small set of named entities + numeric
 * references, normalizes whitespace. Preserves block boundaries by inserting a newline
 * around block-level closing tags (p, div, section, article, h1-h6, li, br, hr, tr).
 *
 * Like the markdown parser, this avoids new dependencies. A future commit can swap in
 * cheerio + turndown for higher fidelity (JS execution still out of scope — content
 * extraction only).
 */
export const htmlParser: DocumentParser = {
  format: 'html',
  version: PARSER_VERSION,
  supportedExtensions: ['html', 'htm', 'xhtml'],
  async parse(input: Uint8Array, opts: ParseOptions): Promise<ParseResult> {
    if (opts.maxFileSizeBytes && input.byteLength > opts.maxFileSizeBytes) {
      return {
        status: 'error',
        format: 'html',
        errorCode: 'file_too_large',
        message: `File ${input.byteLength} bytes exceeds max ${opts.maxFileSizeBytes}`,
        parserVersion: PARSER_VERSION,
      };
    }
    try {
      const raw = new TextDecoder('utf-8', { fatal: false }).decode(input);
      const title = extractTitle(raw);
      const text = htmlToText(raw);
      return {
        status: 'parsed',
        format: 'html',
        text,
        parserVersion: PARSER_VERSION,
        metadata: { byteLength: input.byteLength, title },
      };
    } catch (err) {
      return {
        status: 'error',
        format: 'html',
        errorCode: 'corrupt_input',
        message: err instanceof Error ? err.message : String(err),
        parserVersion: PARSER_VERSION,
      };
    }
  },
};

function extractTitle(raw: string): string | null {
  const lower = raw.replace(/[A-Z]/g, (char) => char.toLowerCase());
  const start = lower.indexOf('<title');
  if (start < 0) return null;
  const openEnd = lower.indexOf('>', start + 6);
  if (openEnd < 0) return null;
  const end = lower.indexOf('</title>', openEnd + 1);
  return end < 0 ? null : decodeEntities(raw.slice(openEnd + 1, end)).trim() || null;
}

export function htmlToText(input: string): string {
  let text = input;
  const output: string[] = [];
  const lower = input.replace(/[A-Z]/g, (char) => char.toLowerCase());
  let cursor = 0;
  while (cursor < input.length) {
    const start = input.indexOf('<', cursor);
    if (start < 0) {
      output.push(input.slice(cursor));
      break;
    }
    output.push(input.slice(cursor, start));
    if (input.startsWith('<!--', start)) {
      const end = input.indexOf('-->', start + 4);
      cursor = end < 0 ? input.length : end + 3;
      continue;
    }
    const end = input.indexOf('>', start + 1);
    if (end < 0) {
      output.push(input.slice(start));
      break;
    }
    const tag = lower.slice(start + 1, end).trim();
    const name = /^(script|style|noscript)\b/.exec(tag)?.[1];
    const breakTag = /^(br|hr)\s*\/?$/.exec(tag)?.[1];
    if (name) {
      let close = lower.indexOf('</' + name, end + 1);
      while (close >= 0 && !/[\s>]/.test(lower[close + name.length + 2] ?? '')) {
        close = lower.indexOf('</' + name, close + name.length + 2);
      }
      const closeEnd = close < 0 ? -1 : input.indexOf('>', close);
      cursor = closeEnd < 0 ? input.length : closeEnd + 1;
      continue;
    }
    if (
      /^\/(p|div|section|article|main|header|footer|h[1-6]|li|tr|table|blockquote|pre)$/.test(
        tag
      ) ||
      breakTag === 'hr'
    ) {
      output.push('\n\n');
    } else if (breakTag === 'br') {
      output.push('\n');
    }
    cursor = end + 1;
    if (breakTag) {
      while (cursor < input.length && /\s/.test(input[cursor]!)) cursor++;
    }
  }
  text = output.join('');
  // Decode entities.
  text = decodeEntities(text);
  // Normalize whitespace.
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n[ \t]+/g, '\n');
  text = text.replace(/[ \t]+\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
  laquo: '«',
  raquo: '»',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (full, name) =>
      NAMED_ENTITIES[name as string] !== undefined ? NAMED_ENTITIES[name as string]! : full
    );
}
