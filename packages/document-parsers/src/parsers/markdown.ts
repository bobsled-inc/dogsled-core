import { randomBytes } from 'node:crypto';

import type { DocumentParser, ParseOptions, ParseResult } from '../types.js';

const PARSER_VERSION = 'md:1.2.0';

/**
 * Markdown parser. Strips Markdown syntax to produce a plain-text body suitable for
 * chunking + embedding. Conservative: keeps headings on their own lines, drops link
 * URLs (keeps anchor text), strips code-fence delimiters but preserves code text,
 * removes images entirely, normalizes whitespace.
 *
 * This is a deliberately small implementation that avoids new dependencies. A future
 * commit can swap in `gray-matter` + `marked` + `turndown` for higher fidelity.
 */
export const markdownParser: DocumentParser = {
  format: 'md',
  version: PARSER_VERSION,
  supportedExtensions: ['md', 'markdown', 'mdx'],
  async parse(input: Uint8Array, opts: ParseOptions): Promise<ParseResult> {
    if (opts.maxFileSizeBytes && input.byteLength > opts.maxFileSizeBytes) {
      return {
        status: 'error',
        format: 'md',
        errorCode: 'file_too_large',
        message: `File ${input.byteLength} bytes exceeds max ${opts.maxFileSizeBytes}`,
        parserVersion: PARSER_VERSION,
      };
    }
    try {
      const raw = new TextDecoder('utf-8', { fatal: false }).decode(input);
      const stripped = stripFrontMatter(raw);
      const text = normalizeMarkdown(stripped.body);
      return {
        status: 'parsed',
        format: 'md',
        text,
        parserVersion: PARSER_VERSION,
        metadata: {
          byteLength: input.byteLength,
          frontMatter: stripped.frontMatter,
        },
      };
    } catch (err) {
      return {
        status: 'error',
        format: 'md',
        errorCode: 'corrupt_input',
        message: err instanceof Error ? err.message : String(err),
        parserVersion: PARSER_VERSION,
      };
    }
  },
};

function stripFrontMatter(raw: string): { body: string; frontMatter: string | null } {
  // Normalize UTF-8 BOM (﻿) + CRLF so files authored on Windows / with UTF-8 BOM
  // still strip correctly. Use the escape form so the regex literal stays ASCII.
  const normalized = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { body: normalized, frontMatter: null };
  const closing = normalized.indexOf('\n---\n', 4);
  if (closing === -1) return { body: normalized, frontMatter: null };
  return { body: normalized.slice(closing + 5), frontMatter: normalized.slice(4, closing) };
}

function normalizeMarkdown(input: string): string {
  let text = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Extract fenced code blocks first so subsequent heading/list/blockquote regexes
  // can't mutate code text. Each block is replaced with a unique placeholder and
  // restored at the end. This preserves "preserve code text" semantics for content
  // like `# CSS` headers, `> import` lines, `1. main()`, `- list` patterns inside
  // code that would otherwise be mangled.
  //
  // Placeholder uses a per-parse random nonce so user content can't forge or collide
  // with placeholder text (e.g. a markdown body that literally writes `@@CBLOCK0@@`
  // would have produced the wrong replacement under a fixed-prefix scheme). The
  // placeholder is pure hex with no underscores or asterisks so it survives the
  // bold/italic strip passes below intact.
  const nonce = randomBytes(8).toString('hex');
  const codeBlocks: string[] = [];
  text = text.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, (_match, code: string) => {
    const idx = codeBlocks.push(code) - 1;
    const idxHex = idx.toString(16).padStart(8, '0');
    return `@@CBLOCK${nonce}IDX${idxHex}@@`;
  });

  // HTML comments
  text = stripComments(text);
  text = stripLinks(stripLinks(text, true));
  // Inline code: `x` → x
  text = text.replace(/`([^`]+)`/g, '$1');
  // Bold/italic markers. Italic uses lookbehind so adjacent italics (`*a* *b*`) match
  // both — the prior captured-group form ate the leading character per match and
  // missed every-other italic.
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/(?<=^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1');
  text = text.replace(/(?<=^|[^_])_([^_\n]+)_(?!_)/g, '$1');
  // Strikethrough
  text = text.replace(/~~([^~]+)~~/g, '$1');
  // ATX headings: leading #s
  text = text.replace(/^#{1,6}\s+/gm, '');
  // Setext headings underlines (===, ---)
  text = text.replace(/\n[=-]{3,}\n/g, '\n\n');
  // Blockquote markers
  text = text.replace(/^>\s?/gm, '');
  // List bullets
  text = text.replace(/^[ \t]*[-*+][ \t]+/gm, '');
  text = text.replace(/^[ \t]*\d+\.[ \t]+/gm, '');
  // Horizontal rules
  text = text.replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, '');

  // Restore code blocks before final whitespace collapse.
  const restoreRegex = new RegExp(`@@CBLOCK${nonce}IDX([0-9a-f]{8})@@`, 'g');
  text = text.replace(
    restoreRegex,
    (_match, idxHex: string) => codeBlocks[Number.parseInt(idxHex, 16)] ?? ''
  );

  // Collapse 3+ newlines to 2
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

function stripComments(input: string): string {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    const start = input.indexOf('<!--', cursor);
    if (start === -1) break;
    const end = input.indexOf('-->', start + 4);
    if (end === -1) break;
    parts.push(input.slice(cursor, start));
    cursor = end + 3;
  }
  parts.push(input.slice(cursor));
  return parts.join('');
}

function stripLinks(input: string, imagesOnly = false): string {
  const parts: string[] = [];
  let cursor = 0;
  let search = 0;
  while (search < input.length) {
    const marker = input.indexOf(imagesOnly ? '![' : '[', search);
    if (marker === -1) break;
    const start = imagesOnly ? marker + 1 : marker;
    const labelEnd = input.indexOf(']', start + 1);
    if (labelEnd === -1) break;
    const delimiter = input[labelEnd + 1];
    if (delimiter !== '(' && delimiter !== '[') {
      search = labelEnd + 1;
      continue;
    }
    const end = input.indexOf(delimiter === '(' ? ')' : ']', labelEnd + 2);
    if (end === -1) break;
    const image = delimiter === '(' && start > cursor && input[start - 1] === '!';
    parts.push(input.slice(cursor, image ? start - 1 : start));
    if (!image) parts.push(input.slice(start + 1, labelEnd));
    cursor = end + 1;
    search = cursor;
  }
  parts.push(input.slice(cursor));
  return parts.join('');
}
