import type { DocumentParser, ParseOptions, ParseResult } from '../types.js';

const PARSER_VERSION = 'txt:1.0.0';

/**
 * Plain-text parser. Decodes UTF-8 (with BOM stripping) and normalizes line endings to
 * LF. Detects UTF-32 BOMs explicitly because chardet can confuse them with UTF-16 (per
 * the unstructured-data plan's research notes).
 */
export const textParser: DocumentParser = {
  format: 'txt',
  version: PARSER_VERSION,
  supportedExtensions: ['txt', 'log', 'text'],
  async parse(input: Uint8Array, opts: ParseOptions): Promise<ParseResult> {
    if (opts.maxFileSizeBytes && input.byteLength > opts.maxFileSizeBytes) {
      return {
        status: 'error',
        format: 'txt',
        errorCode: 'file_too_large',
        message: `File ${input.byteLength} bytes exceeds max ${opts.maxFileSizeBytes}`,
        parserVersion: PARSER_VERSION,
      };
    }

    try {
      const decoded = decodeText(input);
      return {
        status: 'parsed',
        format: 'txt',
        text: normalizeLineEndings(decoded),
        parserVersion: PARSER_VERSION,
        metadata: { byteLength: input.byteLength },
      };
    } catch (err) {
      return {
        status: 'error',
        format: 'txt',
        errorCode: 'corrupt_input',
        message: err instanceof Error ? err.message : String(err),
        parserVersion: PARSER_VERSION,
      };
    }
  },
};

function decodeText(input: Uint8Array): string {
  // UTF-32 BOM check before generic decoding. Both endians covered so neither falls
  // through to UTF-8 and gets parsed as garbage. NOTE: TextDecoder('utf-8') does NOT
  // auto-switch on UTF-16 BOMs, so handle UTF-16 BOMs before the UTF-8 fallback.
  if (input.length >= 4) {
    const isUtf32Le =
      input[0] === 0xff && input[1] === 0xfe && input[2] === 0x00 && input[3] === 0x00;
    const isUtf32Be =
      input[0] === 0x00 && input[1] === 0x00 && input[2] === 0xfe && input[3] === 0xff;
    if (isUtf32Le || isUtf32Be) {
      throw new Error('UTF-32 not supported; convert to UTF-8 first');
    }
  }
  if (input.length >= 2) {
    const isUtf16Le = input[0] === 0xff && input[1] === 0xfe;
    const isUtf16Be = input[0] === 0xfe && input[1] === 0xff;
    if (isUtf16Le) {
      return new TextDecoder('utf-16le').decode(input.subarray(2));
    }
    if (isUtf16Be) {
      return new TextDecoder('utf-16be').decode(input.subarray(2));
    }
  }
  // UTF-8 with BOM stripped
  if (input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(input.subarray(3));
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(input);
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
