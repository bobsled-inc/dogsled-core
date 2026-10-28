/**
 * PDF stream filter decoding.
 *
 * A stream's `/Filter` entry is either a single name or an *array* of names that
 * must be applied in the order they are declared (PDF 32000-1 §7.4.1). ReportLab,
 * LaTeX, and older toolchains routinely emit `[ /ASCII85Decode /FlateDecode ]`,
 * so decoding only the last stage feeds ASCII text into zlib.
 *
 * Every decoder bounds its own output: the file-level size cap only limits the
 * *encoded* input, and Flate, LZW, and RunLength can all expand a small stream
 * into gigabytes.
 */

import { inflateSync } from 'node:zlib';

/** A stream stage produced more bytes than the caller allows. */
export class PdfFilterLimitError extends Error {
  constructor() {
    super('PDF stream filter output exceeds the decode limit');
    this.name = 'PdfFilterLimitError';
  }
}

/** A stream stage rejected its input. Carries the stage and owning object. */
export class PdfFilterError extends Error {
  constructor(
    readonly filter: string,
    objectRef: string | undefined,
    reason: string
  ) {
    const where = objectRef ? ` on object ${objectRef}` : '';
    super(`PDF stream filter /${filter} failed${where}: ${reason}`);
    this.name = 'PdfFilterError';
  }
}

/** Standard abbreviations permitted for inline images (PDF 32000-1 Table 93). */
const PDF_FILTER_ABBREVIATIONS: Readonly<Record<string, string>> = {
  AHx: 'ASCIIHexDecode',
  A85: 'ASCII85Decode',
  LZW: 'LZWDecode',
  Fl: 'FlateDecode',
  RL: 'RunLengthDecode',
  CCF: 'CCITTFaxDecode',
  DCT: 'DCTDecode',
};

/** What a stream dictionary's `/Filter` entry turned out to be. */
export type PdfFilterChain =
  /** No `/Filter` entry — the stream body is raw bytes. */
  | { readonly kind: 'raw' }
  /** Stages to apply in order; empty for an explicit `/Filter []`. */
  | { readonly kind: 'filters'; readonly names: readonly string[] }
  /** A `/Filter` we cannot resolve, such as an indirect reference. Skip the stream. */
  | { readonly kind: 'unresolved' };

/**
 * Read the `/Filter` chain from a stream dictionary, normalizing abbreviations.
 *
 * The dictionary text handed to us can span more than one object, because the
 * `<<...>>\s*stream` scan backtracks across preceding non-stream dictionaries.
 * The stream's own dictionary is always the one closest to the `stream` keyword,
 * so the *last* `/Filter` in the text is the relevant one.
 */
export function parsePdfFilterChain(dict: string): PdfFilterChain {
  let value: string | undefined;
  for (const match of dict.matchAll(/\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9#]+)/g)) {
    value = match[1];
  }
  if (!value) return /\/Filter\b/.test(dict) ? { kind: 'unresolved' } : { kind: 'raw' };
  const names = value.startsWith('[')
    ? [...value.matchAll(/\/([A-Za-z0-9#]+)/g)].map((entry) => entry[1]!)
    : [value.slice(1)];
  return { kind: 'filters', names: names.map((name) => PDF_FILTER_ABBREVIATIONS[name] ?? name) };
}

type StreamDecoder = (bytes: Uint8Array, maxOutputBytes: number) => Uint8Array;

export interface ApplyFilterChainOptions {
  /** Per-stage output cap; exceeding it raises {@link PdfFilterLimitError}. */
  readonly maxOutputBytes: number;
  /**
   * Resolves the owning object's `"<num> <gen>"`. Called only when a stage fails,
   * so locating the object header costs nothing on the success path.
   */
  readonly resolveObjectRef?: (() => string | undefined) | undefined;
}

/**
 * Apply every stage of a `/Filter` chain in declaration order.
 *
 * Returns `null` when a stage is an image or unrecognized codec — those streams
 * carry no extractable text and the caller skips them, which is what the parser
 * did for every non-Flate filter before chains were understood.
 *
 * @throws {PdfFilterError} when a stage rejects its input.
 * @throws {PdfFilterLimitError} when a stage exceeds `maxOutputBytes`.
 */
export function applyPdfFilterChain(
  bytes: Uint8Array,
  filters: readonly string[],
  options: ApplyFilterChainOptions
): Uint8Array | null {
  // Decide before decoding anything. A stream ending in an image codec is skipped
  // whatever its body holds, so running its ASCII stages first would only turn a
  // malformed image — previously ignored — into a whole-document failure.
  if (filters.some((filter) => !PDF_STREAM_DECODERS.has(filter))) return null;

  let current = bytes;
  for (const filter of filters) {
    const decoder = PDF_STREAM_DECODERS.get(filter)!;
    try {
      current = decoder(current, options.maxOutputBytes);
    } catch (error) {
      if (error instanceof PdfFilterLimitError) throw error;
      throw new PdfFilterError(
        filter,
        options.resolveObjectRef?.(),
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  return current;
}

/** Growable output buffer that refuses to exceed a byte budget. */
class ByteSink {
  private data: Uint8Array;
  private length = 0;

  constructor(
    private readonly maxBytes: number,
    initialCapacity: number
  ) {
    this.data = new Uint8Array(Math.max(Math.min(initialCapacity, maxBytes), 64));
  }

  push(byte: number): void {
    this.reserve(1);
    this.data[this.length] = byte;
    this.length += 1;
  }

  append(source: Uint8Array, start = 0, end = source.length): void {
    const count = end - start;
    if (count <= 0) return;
    this.reserve(count);
    this.data.set(source.subarray(start, end), this.length);
    this.length += count;
  }

  toBytes(): Uint8Array {
    return this.data.subarray(0, this.length);
  }

  private reserve(count: number): void {
    const required = this.length + count;
    if (required > this.maxBytes) throw new PdfFilterLimitError();
    if (required <= this.data.length) return;
    let capacity = this.data.length;
    while (capacity < required) capacity *= 2;
    const grown = new Uint8Array(Math.min(capacity, this.maxBytes));
    grown.set(this.data.subarray(0, this.length));
    this.data = grown;
  }
}

function isPdfWhitespace(code: number): boolean {
  return (
    code === 0x00 ||
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0c ||
    code === 0x0d ||
    code === 0x20
  );
}

function decodeFlate(bytes: Uint8Array, maxOutputBytes: number): Uint8Array {
  try {
    return new Uint8Array(inflateSync(bytes, { maxOutputLength: maxOutputBytes }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new PdfFilterLimitError();
    }
    throw error;
  }
}

const ASCII85_ZERO_GROUP = new Uint8Array(4);

/** ASCII85: five base-85 digits (`!`..`u`) per four bytes, `z` for four zeros, `~>` terminator. */
function decodeAscii85(bytes: Uint8Array, maxOutputBytes: number): Uint8Array {
  const out = new ByteSink(maxOutputBytes, bytes.length);
  let index = 0;
  // `<~` is Adobe's optional start marker. PDF omits it, but some producers emit it.
  if (bytes[0] === 0x3c && bytes[1] === 0x7e) index = 2;
  let tuple = 0;
  let digits = 0;
  for (; index < bytes.length; index += 1) {
    const code = bytes[index]!;
    if (isPdfWhitespace(code)) continue;
    if (code === 0x7e) break; // `~` opens the `~>` end-of-data marker
    if (code === 0x7a && digits === 0) {
      out.append(ASCII85_ZERO_GROUP);
      continue;
    }
    if (code < 0x21 || code > 0x75) {
      throw new Error(`invalid ASCII85 character 0x${code.toString(16).padStart(2, '0')}`);
    }
    tuple = tuple * 85 + (code - 0x21);
    digits += 1;
    if (digits === 5) {
      pushAscii85Group(out, tuple, 4);
      tuple = 0;
      digits = 0;
    }
  }
  if (digits === 1) throw new Error('ASCII85 data ends with an orphan digit');
  if (digits > 1) {
    for (let pad = digits; pad < 5; pad += 1) tuple = tuple * 85 + 84;
    pushAscii85Group(out, tuple, digits - 1);
  }
  return out.toBytes();
}

function pushAscii85Group(out: ByteSink, tuple: number, byteCount: number): void {
  if (tuple > 0xffffffff) throw new Error('ASCII85 group overflows 32 bits');
  for (let i = 0; i < byteCount; i += 1) {
    out.push((tuple >>> (24 - i * 8)) & 0xff);
  }
}

/** ASCIIHex: hex digits, whitespace ignored, `>` terminator, odd trailing digit padded with 0. */
function decodeAsciiHex(bytes: Uint8Array, maxOutputBytes: number): Uint8Array {
  const out = new ByteSink(maxOutputBytes, Math.ceil(bytes.length / 2));
  let high = -1;
  for (const code of bytes) {
    if (code === 0x3e) break; // `>` end-of-data
    if (isPdfWhitespace(code)) continue;
    const digit = hexDigit(code);
    if (digit < 0) {
      throw new Error(`invalid ASCIIHex character 0x${code.toString(16).padStart(2, '0')}`);
    }
    if (high < 0) {
      high = digit;
    } else {
      out.push((high << 4) | digit);
      high = -1;
    }
  }
  if (high >= 0) out.push(high << 4);
  return out.toBytes();
}

function hexDigit(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x37;
  if (code >= 0x61 && code <= 0x66) return code - 0x57;
  return -1;
}

const LZW_CLEAR_TABLE = 256;
const LZW_END_OF_DATA = 257;
const LZW_FIRST_CODE = 258;
const LZW_MAX_TABLE_SIZE = 4096;
const LZW_MIN_CODE_WIDTH = 9;
const LZW_MAX_CODE_WIDTH = 12;

/**
 * LZW as PDF uses it: MSB-first codes starting at 9 bits, `EarlyChange = 1`.
 *
 * Early change means the encoder widens the code one entry *before* the table
 * actually fills. The decoder builds each entry one code later than the encoder
 * did, so it is always one entry behind — hence the `+ 2` in the widen test where
 * the encoder uses `+ 1`.
 */
function decodeLzw(bytes: Uint8Array, maxOutputBytes: number): Uint8Array {
  const out = new ByteSink(maxOutputBytes, bytes.length * 2);
  let table = createLzwTable();
  let codeWidth = LZW_MIN_CODE_WIDTH;
  let previous: Uint8Array | null = null;
  let bitBuffer = 0;
  let bitCount = 0;
  let index = 0;

  for (;;) {
    while (bitCount < codeWidth && index < bytes.length) {
      bitBuffer = ((bitBuffer << 8) | bytes[index]!) >>> 0;
      bitCount += 8;
      index += 1;
    }
    if (bitCount < codeWidth) break; // input exhausted without an explicit EOD
    bitCount -= codeWidth;
    const code = (bitBuffer >>> bitCount) & ((1 << codeWidth) - 1);
    bitBuffer &= (1 << bitCount) - 1;

    if (code === LZW_END_OF_DATA) break;
    if (code === LZW_CLEAR_TABLE) {
      table = createLzwTable();
      codeWidth = LZW_MIN_CODE_WIDTH;
      previous = null;
      continue;
    }

    let entry: Uint8Array;
    if (code < table.length) {
      entry = table[code]!;
    } else if (previous !== null && code === table.length) {
      // The encoder emitted a code for an entry the decoder has not built yet.
      entry = appendByte(previous, previous[0]!);
    } else {
      throw new Error(`LZW code ${code} is outside the decode table`);
    }
    out.append(entry);

    if (previous !== null && table.length < LZW_MAX_TABLE_SIZE) {
      table.push(appendByte(previous, entry[0]!));
    }
    previous = entry;
    if (table.length + 2 > 1 << codeWidth && codeWidth < LZW_MAX_CODE_WIDTH) {
      codeWidth += 1;
    }
  }
  return out.toBytes();
}

function createLzwTable(): Uint8Array[] {
  const table: Uint8Array[] = [];
  for (let code = 0; code < LZW_FIRST_CODE; code += 1) {
    table.push(code < 256 ? Uint8Array.of(code) : new Uint8Array(0));
  }
  return table;
}

function appendByte(prefix: Uint8Array, suffix: number): Uint8Array {
  const result = new Uint8Array(prefix.length + 1);
  result.set(prefix);
  result[prefix.length] = suffix;
  return result;
}

/** RunLength: a length byte, then a literal run (0-127) or a repeated byte (129-255); 128 ends data. */
function decodeRunLength(bytes: Uint8Array, maxOutputBytes: number): Uint8Array {
  const out = new ByteSink(maxOutputBytes, bytes.length * 2);
  let index = 0;
  while (index < bytes.length) {
    const marker = bytes[index]!;
    index += 1;
    if (marker === 128) break;
    if (marker < 128) {
      const end = Math.min(index + marker + 1, bytes.length);
      out.append(bytes, index, end);
      index = end;
      continue;
    }
    const value = bytes[index];
    if (value === undefined) break;
    index += 1;
    for (let repeat = 0; repeat < 257 - marker; repeat += 1) out.push(value);
  }
  return out.toBytes();
}

/**
 * Filters that can yield text. Everything else — `DCTDecode`, `JPXDecode`,
 * `CCITTFaxDecode`, `JBIG2Decode`, `Crypt`, and unknown names — marks a stream
 * the parser skips. A `Map` keeps inherited `Object` members (`toString`, ...)
 * from being mistaken for decoders when a PDF names them as filters.
 */
const PDF_STREAM_DECODERS = new Map<string, StreamDecoder>([
  ['ASCII85Decode', decodeAscii85],
  ['ASCIIHexDecode', decodeAsciiHex],
  ['FlateDecode', decodeFlate],
  ['LZWDecode', decodeLzw],
  ['RunLengthDecode', decodeRunLength],
]);
