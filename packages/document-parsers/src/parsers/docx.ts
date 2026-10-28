import type { DocumentParser, ParseOptions, ParseResult } from '../types.js';

import { extractWordXmlText, normalizeExtractedText } from './xml.js';
import { readZipEntries, ZipReadError } from './zip.js';

const PARSER_VERSION = 'docx:1.0.0';

export const docxParser: DocumentParser = {
  format: 'docx',
  version: PARSER_VERSION,
  supportedExtensions: ['docx'],
  async parse(input: Uint8Array, opts: ParseOptions): Promise<ParseResult> {
    if (opts.maxFileSizeBytes && input.byteLength > opts.maxFileSizeBytes) {
      return {
        status: 'error',
        format: 'docx',
        errorCode: 'file_too_large',
        message: `File ${input.byteLength} bytes exceeds max ${opts.maxFileSizeBytes}`,
        parserVersion: PARSER_VERSION,
      };
    }

    try {
      const entries = readZipEntries(input, {
        maxUncompressedBytes: opts.maxFileSizeBytes ?? 500 * 1024 * 1024,
      });
      const parts = [
        'word/document.xml',
        ...[...entries.keys()]
          .filter((name) =>
            /^word\/(?:footnotes|endnotes|comments|header\d+|footer\d+)\.xml$/.test(name)
          )
          .sort(),
      ];
      const extracted: string[] = [];
      for (const part of parts) {
        const entry = entries.get(part);
        if (!entry) continue;
        const xml = new TextDecoder('utf-8', { fatal: false }).decode(entry.data);
        const text = extractWordXmlText(xml);
        if (text) extracted.push(text);
      }
      if (extracted.length === 0) {
        return {
          status: 'error',
          format: 'docx',
          errorCode: 'corrupt_input',
          message: 'DOCX container did not include extractable word/document.xml text',
          parserVersion: PARSER_VERSION,
        };
      }
      return {
        status: 'parsed',
        format: 'docx',
        text: normalizeExtractedText(extracted.join('\n\n')),
        parserVersion: PARSER_VERSION,
        metadata: {
          byteLength: input.byteLength,
          partCount: entries.size,
          extractedParts: extracted.length,
        },
      };
    } catch (err) {
      return docxError(err);
    }
  },
};

function docxError(err: unknown): ParseResult {
  if (err instanceof ZipReadError) {
    return {
      status: 'error',
      format: 'docx',
      errorCode: err.code === 'unsupported_format' ? 'corrupt_input' : err.code,
      message: err.message,
      parserVersion: PARSER_VERSION,
    };
  }
  return {
    status: 'error',
    format: 'docx',
    errorCode: 'corrupt_input',
    message: err instanceof Error ? err.message : String(err),
    parserVersion: PARSER_VERSION,
  };
}
