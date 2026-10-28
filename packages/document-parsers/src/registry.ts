import { htmlParser } from './parsers/html.js';
import { markdownParser } from './parsers/markdown.js';
import { docxParser } from './parsers/docx.js';
import { emailParser } from './parsers/email.js';
import { pdfParser } from './parsers/pdf.js';
import { pptxParser } from './parsers/pptx.js';
import { textParser } from './parsers/text.js';
import type {
  DocumentFormat,
  DocumentParser,
  ParseError,
  ParseOptions,
  ParseResult,
} from './types.js';

/**
 * Parser registry. Keyed by `DocumentFormat`. Callers either look up a parser by
 * extension via `parserForExtension()` or by format via `getParser()`. Unknown
 * formats / extensions return `undefined`; the runtime turns that into a
 * `__parse_errors` row (`error_code: 'unsupported_format'`).
 *
 * The default registry wires the seven v1 formats. The binary/container formats use
 * dependency-free parsers so the ingestion contract works without widening the
 * workspace dependency surface.
 */
export class DocumentParserRegistry {
  private readonly byFormat = new Map<DocumentFormat, DocumentParser>();
  private readonly byExtension = new Map<string, DocumentParser>();

  register(parser: DocumentParser): void {
    this.byFormat.set(parser.format, parser);
    for (const ext of parser.supportedExtensions) {
      this.byExtension.set(ext.toLowerCase(), parser);
    }
  }

  getParser(format: DocumentFormat): DocumentParser | undefined {
    return this.byFormat.get(format);
  }

  parserForExtension(extension: string): DocumentParser | undefined {
    return this.byExtension.get(extension.toLowerCase());
  }

  parserForUri(sourceUri: string): DocumentParser | undefined {
    // Strip query string and fragment so that URIs like `s3://bucket/q4.pdf?versionId=1`
    // or `https://docs/page.html#section` extract the real extension instead of
    // `pdf?versionId=1` / `html#section` and miss the registry lookup.
    const queryIdx = sourceUri.indexOf('?');
    const fragIdx = sourceUri.indexOf('#');
    let pathPart = sourceUri;
    if (queryIdx >= 0 || fragIdx >= 0) {
      const cutoff = Math.min(
        queryIdx >= 0 ? queryIdx : sourceUri.length,
        fragIdx >= 0 ? fragIdx : sourceUri.length
      );
      pathPart = sourceUri.slice(0, cutoff);
    }
    const dot = pathPart.lastIndexOf('.');
    if (dot < 0 || dot === pathPart.length - 1) return undefined;
    return this.parserForExtension(pathPart.slice(dot + 1));
  }

  async parse(sourceUri: string, bytes: Uint8Array, opts: ParseOptions): Promise<ParseResult> {
    const parser = this.parserForUri(sourceUri);
    if (!parser) {
      const sanitizedUri = sanitizeUriForError(sourceUri);
      const err: ParseError = {
        status: 'error',
        // `'unknown'` is the registry's marker for "no parser claimed this extension".
        // Mirrors the runtime allowlist behavior in document-extraction.ts so the
        // __parse_errors stream is consistent across both rejection paths.
        format: 'unknown',
        errorCode: 'unsupported_format',
        message: `No parser registered for extension in URI ${sanitizedUri}`,
        parserVersion: 'registry:1.0.0',
      };
      return err;
    }
    try {
      return await parser.parse(bytes, opts);
    } catch (err) {
      const failure: ParseError = {
        status: 'error',
        format: parser.format,
        errorCode: 'parser_internal_error',
        message: err instanceof Error ? err.message : String(err),
        parserVersion: parser.version,
      };
      return failure;
    }
  }
}

/**
 * Strip query string + fragment before persisting the URI to error messages or
 * data columns: pre-signed S3/GCS URIs carry credentials in the query string and
 * would otherwise leak into `__parse_errors` and downstream logs.
 */
export function sanitizeUriForError(sourceUri: string): string {
  const cutoff = sourceUri.search(/[?#]/);
  return cutoff >= 0 ? sourceUri.slice(0, cutoff) : sourceUri;
}

/** Build the default registry with all seven v1 parsers wired. */
export function createDefaultRegistry(): DocumentParserRegistry {
  const reg = new DocumentParserRegistry();
  reg.register(textParser);
  reg.register(markdownParser);
  reg.register(htmlParser);
  reg.register(pdfParser);
  reg.register(docxParser);
  reg.register(pptxParser);
  reg.register(emailParser);
  return reg;
}
