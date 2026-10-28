import type { DocumentParser, ParseOptions, ParseResult } from '../types.js';

import { applyPdfFilterChain, parsePdfFilterChain, PdfFilterLimitError } from './pdf-filters.js';
import { normalizeExtractedText } from './xml.js';

const PARSER_VERSION = 'pdf:1.1.0';

export const PDF_SECURITY_LIMITS = {
  maxStreams: 4_096,
  maxStreamBytes: 16 * 1024 * 1024,
  maxDecompressedBytes: 32 * 1024 * 1024,
  maxExtractedTextChars: 8 * 1024 * 1024,
  maxTextBlocks: 100_000,
  maxPages: 100_000,
} as const;

/** How far back to look for the `N G obj` header owning a stream. */
const OBJECT_HEADER_LOOKBEHIND = 8_192;

class PdfLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfLimitError';
  }
}

export const pdfParser: DocumentParser = {
  format: 'pdf',
  version: PARSER_VERSION,
  supportedExtensions: ['pdf'],
  async parse(input: Uint8Array, opts: ParseOptions): Promise<ParseResult> {
    if (opts.maxFileSizeBytes && input.byteLength > opts.maxFileSizeBytes) {
      return {
        status: 'error',
        format: 'pdf',
        errorCode: 'file_too_large',
        message: `File ${input.byteLength} bytes exceeds max ${opts.maxFileSizeBytes}`,
        parserVersion: PARSER_VERSION,
      };
    }

    try {
      const raw = Buffer.from(input).toString('latin1');
      if (!raw.slice(0, 1024).includes('%PDF-')) {
        return pdfCorrupt('Input does not start with a PDF header');
      }
      if (/\/Encrypt\b/.test(raw)) {
        return {
          status: 'error',
          format: 'pdf',
          errorCode: 'encrypted_input',
          message: 'Encrypted PDF inputs are not supported',
          parserVersion: PARSER_VERSION,
        };
      }

      const streams = extractPdfStreams(raw);
      const textBudget = { chars: 0, blocks: 0 };
      const textBlocks: string[] = [];
      for (const stream of streams) {
        for (const block of extractTextFromContent(stream, textBudget)) {
          textBlocks.push(block);
        }
      }
      const text = normalizeExtractedText(textBlocks.join('\n'));
      return {
        status: 'parsed',
        format: 'pdf',
        text,
        parserVersion: PARSER_VERSION,
        metadata: {
          byteLength: input.byteLength,
          pageCount: countPages(raw),
          streamCount: streams.length,
        },
      };
    } catch (err) {
      if (err instanceof PdfLimitError) {
        return pdfTooLarge(err.message);
      }
      return pdfCorrupt(err instanceof Error ? err.message : String(err));
    }
  },
};

function pdfTooLarge(message: string): ParseResult {
  return {
    status: 'error',
    format: 'pdf',
    errorCode: 'file_too_large',
    message,
    parserVersion: PARSER_VERSION,
  };
}

function pdfCorrupt(message: string): ParseResult {
  return {
    status: 'error',
    format: 'pdf',
    errorCode: 'corrupt_input',
    message,
    parserVersion: PARSER_VERSION,
  };
}

function countPages(raw: string): number {
  const pageRe = /\/Type\s*\/Page\b/g;
  let pageCount = 0;
  while (pageRe.exec(raw) !== null) {
    pageCount += 1;
    if (pageCount > PDF_SECURITY_LIMITS.maxPages) {
      throw new PdfLimitError(`PDF contains more than ${PDF_SECURITY_LIMITS.maxPages} pages`);
    }
  }
  return pageCount;
}

function extractPdfStreams(raw: string): string[] {
  const streams: string[] = [];
  let totalDecompressedBytes = 0;
  let seenStreams = 0;
  const streamRe = /<<([\s\S]*?)>>\s*stream(?:\r\n|\n|\r)?/g;
  let match: RegExpExecArray | null;
  while ((match = streamRe.exec(raw)) !== null) {
    seenStreams += 1;
    if (seenStreams > PDF_SECURITY_LIMITS.maxStreams) {
      throw new PdfLimitError(
        `PDF contains more than ${PDF_SECURITY_LIMITS.maxStreams} content streams`
      );
    }
    const dict = match[1] ?? '';
    const bodyStart = streamRe.lastIndex;
    const lengthMatch = dict.match(/\/Length\s+(\d+)/);
    let body: string;
    if (lengthMatch?.[1]) {
      const length = Number.parseInt(lengthMatch[1], 10);
      body = raw.slice(bodyStart, bodyStart + length);
      streamRe.lastIndex = bodyStart + length;
    } else {
      const end = raw.indexOf('endstream', bodyStart);
      if (end < 0) continue;
      body = raw.slice(bodyStart, end).replace(/\r?\n$/, '');
      streamRe.lastIndex = end + 'endstream'.length;
    }
    let bytes = latin1Bytes(body);
    const chain = parsePdfFilterChain(dict);
    if (chain.kind === 'unresolved') continue;
    if (chain.kind === 'filters') {
      let decoded: Uint8Array | null;
      try {
        // Bound decoded output to defend against zip-bomb-style PDF streams. The
        // file-level `maxFileSizeBytes` cap only limits the encoded input; a small
        // compressed stream can still inflate to gigabytes. 16 MiB per stream is well
        // above any reasonable PDF text-content size.
        decoded = applyPdfFilterChain(bytes, chain.names, {
          maxOutputBytes: PDF_SECURITY_LIMITS.maxStreamBytes,
          resolveObjectRef: () => findObjectRef(raw, bodyStart),
        });
      } catch (error) {
        if (error instanceof PdfFilterLimitError) {
          throw new PdfLimitError(
            `PDF content stream exceeds the ${PDF_SECURITY_LIMITS.maxStreamBytes}-byte decompression limit`
          );
        }
        throw error;
      }
      // Image and unknown codecs carry no extractable text.
      if (decoded === null) continue;
      bytes = decoded;
    }
    totalDecompressedBytes += bytes.byteLength;
    if (totalDecompressedBytes > PDF_SECURITY_LIMITS.maxDecompressedBytes) {
      throw new PdfLimitError(
        `PDF content streams exceed the ${PDF_SECURITY_LIMITS.maxDecompressedBytes}-byte aggregate decompression limit`
      );
    }
    streams.push(Buffer.from(bytes).toString('latin1'));
  }
  if (streams.length === 0) {
    if (Buffer.byteLength(raw, 'latin1') > PDF_SECURITY_LIMITS.maxDecompressedBytes) {
      throw new PdfLimitError(
        `PDF content exceeds the ${PDF_SECURITY_LIMITS.maxDecompressedBytes}-byte processing limit`
      );
    }
    streams.push(raw);
  }
  return streams;
}

/**
 * Best-effort `"<num> <gen>"` of the object owning the stream that starts at
 * `bodyStart`, for filter-failure diagnostics.
 *
 * The stream body is always preceded by its object header, so the nearest
 * `N G obj` behind it is the owner. The lookbehind is bounded because the
 * dictionary text can itself span earlier objects.
 */
function findObjectRef(raw: string, bodyStart: number): string | undefined {
  const window = raw.slice(Math.max(0, bodyStart - OBJECT_HEADER_LOOKBEHIND), bodyStart);
  let last: RegExpExecArray | null = null;
  const headerRe = /(\d+)\s+(\d+)\s+obj\b/g;
  let match: RegExpExecArray | null;
  while ((match = headerRe.exec(window)) !== null) last = match;
  return last ? `${last[1]} ${last[2]}` : undefined;
}

function extractTextFromContent(
  content: string,
  budget: { chars: number; blocks: number }
): string[] {
  const out: string[] = [];

  const tjRe = /(\((?:\\.|[^\\)])*\)|<[\da-fA-F\s]+>)\s*Tj\b/g;
  let match: RegExpExecArray | null;
  while ((match = tjRe.exec(content)) !== null) {
    const value = decodePdfStringToken(match[1] ?? '');
    appendTextBlock(out, value, budget);
  }

  const arrayRe = /\[([\s\S]*?)\]\s*TJ\b/g;
  while ((match = arrayRe.exec(content)) !== null) {
    const body = match[1] ?? '';
    const pieceRe = /\((?:\\.|[^\\)])*\)|<[\da-fA-F\s]+>/g;
    let pieceMatch: RegExpExecArray | null;
    const pieces: string[] = [];
    let joinedLength = 0;
    while ((pieceMatch = pieceRe.exec(body)) !== null) {
      if (pieces.length >= PDF_SECURITY_LIMITS.maxTextBlocks) {
        throw new PdfLimitError(
          `PDF text array exceeds the ${PDF_SECURITY_LIMITS.maxTextBlocks}-piece limit`
        );
      }
      const piece = decodePdfStringToken(pieceMatch[0]);
      pieces.push(piece);
      joinedLength += piece.length;
      if (budget.chars + joinedLength > PDF_SECURITY_LIMITS.maxExtractedTextChars) {
        throw new PdfLimitError(
          `PDF extracted text exceeds the ${PDF_SECURITY_LIMITS.maxExtractedTextChars}-character limit`
        );
      }
    }
    appendTextBlock(out, pieces.join(''), budget);
  }

  const quoteRe = /(\((?:\\.|[^\\)])*\))\s*['"]/g;
  while ((match = quoteRe.exec(content)) !== null) {
    const value = decodePdfStringToken(match[1] ?? '');
    appendTextBlock(out, value, budget);
  }

  return out;
}

function appendTextBlock(
  output: string[],
  value: string,
  budget: { chars: number; blocks: number }
): void {
  if (!value) return;
  if (budget.blocks >= PDF_SECURITY_LIMITS.maxTextBlocks) {
    throw new PdfLimitError(
      `PDF extracted text exceeds the ${PDF_SECURITY_LIMITS.maxTextBlocks}-block limit`
    );
  }
  if (budget.chars + value.length > PDF_SECURITY_LIMITS.maxExtractedTextChars) {
    throw new PdfLimitError(
      `PDF extracted text exceeds the ${PDF_SECURITY_LIMITS.maxExtractedTextChars}-character limit`
    );
  }
  output.push(value);
  budget.blocks += 1;
  budget.chars += value.length;
}

function decodePdfStringToken(token: string): string {
  if (token.startsWith('<')) {
    return decodePdfHexString(token);
  }
  return decodePdfLiteralString(token);
}

function decodePdfHexString(token: string): string {
  const hex = token.slice(1, -1).replace(/\s+/g, '');
  const padded = hex.length % 2 === 0 ? hex : `${hex}0`;
  const bytes: number[] = [];
  for (let i = 0; i < padded.length; i += 2) {
    bytes.push(Number.parseInt(padded.slice(i, i + 2), 16));
  }
  return decodePdfBytes(new Uint8Array(bytes));
}

function decodePdfLiteralString(token: string): string {
  const bytes: number[] = [];
  for (let i = 1; i < token.length - 1; i += 1) {
    const char = token[i]!;
    if (char !== '\\') {
      bytes.push(char.charCodeAt(0) & 0xff);
      continue;
    }
    const next = token[++i];
    if (next === undefined) break;
    switch (next) {
      case 'n':
        bytes.push(0x0a);
        break;
      case 'r':
        bytes.push(0x0d);
        break;
      case 't':
        bytes.push(0x09);
        break;
      case 'b':
        bytes.push(0x08);
        break;
      case 'f':
        bytes.push(0x0c);
        break;
      case '(':
      case ')':
      case '\\':
        bytes.push(next.charCodeAt(0));
        break;
      case '\n':
        break;
      case '\r':
        if (token[i + 1] === '\n') i += 1;
        break;
      default:
        if (/[0-7]/.test(next)) {
          let octal = next;
          for (let j = 0; j < 2 && /[0-7]/.test(token[i + 1] ?? ''); j += 1) {
            octal += token[++i]!;
          }
          bytes.push(Number.parseInt(octal, 8) & 0xff);
        } else {
          bytes.push(next.charCodeAt(0) & 0xff);
        }
    }
  }
  return decodePdfBytes(new Uint8Array(bytes));
}

function decodePdfBytes(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const chars: number[] = [];
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      chars.push((bytes[i]! << 8) | bytes[i + 1]!);
    }
    return String.fromCharCode(...chars);
  }
  return Buffer.from(bytes).toString('latin1');
}

function latin1Bytes(input: string): Uint8Array {
  const bytes = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    bytes[i] = input.charCodeAt(i) & 0xff;
  }
  return bytes;
}
