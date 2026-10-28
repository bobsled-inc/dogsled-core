import type { DocumentParser, ParseOptions, ParseResult } from '../types.js';

import { extractDrawingXmlText, normalizeExtractedText } from './xml.js';
import { readZipEntries, ZipReadError } from './zip.js';

const PARSER_VERSION = 'pptx:1.0.0';

export const pptxParser: DocumentParser = {
  format: 'pptx',
  version: PARSER_VERSION,
  supportedExtensions: ['pptx'],
  async parse(input: Uint8Array, opts: ParseOptions): Promise<ParseResult> {
    if (opts.maxFileSizeBytes && input.byteLength > opts.maxFileSizeBytes) {
      return {
        status: 'error',
        format: 'pptx',
        errorCode: 'file_too_large',
        message: `File ${input.byteLength} bytes exceeds max ${opts.maxFileSizeBytes}`,
        parserVersion: PARSER_VERSION,
      };
    }

    try {
      const entries = readZipEntries(input, {
        maxUncompressedBytes: opts.maxFileSizeBytes ?? 500 * 1024 * 1024,
      });
      const slideNames = [...entries.keys()]
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
        .sort(compareSlideNames);
      if (slideNames.length === 0) {
        return {
          status: 'error',
          format: 'pptx',
          errorCode: 'corrupt_input',
          message: 'PPTX container did not include ppt/slides/slide*.xml parts',
          parserVersion: PARSER_VERSION,
        };
      }

      const slides: string[] = [];
      for (const name of slideNames) {
        const entry = entries.get(name);
        if (!entry) continue;
        const xml = new TextDecoder('utf-8', { fatal: false }).decode(entry.data);
        const text = extractDrawingXmlText(xml);
        if (text) slides.push(text);
      }

      return {
        status: 'parsed',
        format: 'pptx',
        text: normalizeExtractedText(slides.join('\n\n')),
        parserVersion: PARSER_VERSION,
        metadata: {
          byteLength: input.byteLength,
          slideCount: slideNames.length,
          slidesWithText: slides.length,
        },
      };
    } catch (err) {
      return pptxError(err);
    }
  },
};

function compareSlideNames(a: string, b: string): number {
  return slideNumber(a) - slideNumber(b);
}

function slideNumber(name: string): number {
  const match = name.match(/slide(\d+)\.xml$/);
  return match?.[1] ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function pptxError(err: unknown): ParseResult {
  if (err instanceof ZipReadError) {
    return {
      status: 'error',
      format: 'pptx',
      errorCode: err.code === 'unsupported_format' ? 'corrupt_input' : err.code,
      message: err.message,
      parserVersion: PARSER_VERSION,
    };
  }
  return {
    status: 'error',
    format: 'pptx',
    errorCode: 'corrupt_input',
    message: err instanceof Error ? err.message : String(err),
    parserVersion: PARSER_VERSION,
  };
}
