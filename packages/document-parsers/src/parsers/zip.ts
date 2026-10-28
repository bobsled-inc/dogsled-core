import { inflateRawSync } from 'node:zlib';

type ZipReadErrorCode =
  | 'corrupt_input'
  | 'encrypted_input'
  | 'file_too_large'
  | 'unsupported_format';

export class ZipReadError extends Error {
  readonly code: ZipReadErrorCode;

  constructor(code: ZipReadErrorCode, message: string) {
    super(message);
    this.name = 'ZipReadError';
    this.code = code;
  }
}

export interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP64_SENTINEL = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;

/**
 * Default absolute uncompressed-size cap (per entry AND aggregate). Caller-supplied
 * `maxUncompressedBytes` overrides this. The cap defends against ZIP-bomb-style
 * inputs where a small archive declares a small `uncompressedSize` but inflates to
 * far more — even with the per-stream `inflateRawSync({ maxOutputLength })` cap, the
 * header values themselves can be untrusted, so we validate them against this
 * absolute ceiling before allocating any inflation buffer.
 */
const DEFAULT_MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

export function readZipEntries(
  input: Uint8Array,
  opts: { maxUncompressedBytes?: number } = {}
): Map<string, ZipEntry> {
  const maxUncompressedBytes = opts.maxUncompressedBytes ?? DEFAULT_MAX_UNCOMPRESSED_BYTES;
  const eocdOffset = findEndOfCentralDirectory(input);
  const entryCount = readUInt16LE(input, eocdOffset + 10);
  const centralDirectoryOffset = readUInt32LE(input, eocdOffset + 16);
  if (entryCount === ZIP64_SENTINEL || centralDirectoryOffset === ZIP64_SENTINEL_32) {
    throw new ZipReadError('unsupported_format', 'ZIP64 OOXML containers are not supported');
  }

  const entries = new Map<string, ZipEntry>();
  let offset = centralDirectoryOffset;
  let totalUncompressed = 0;
  for (let i = 0; i < entryCount; i += 1) {
    if (readUInt32LE(input, offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new ZipReadError('corrupt_input', 'Invalid ZIP central directory entry');
    }
    const flags = readUInt16LE(input, offset + 8);
    const method = readUInt16LE(input, offset + 10);
    const compressedSize = readUInt32LE(input, offset + 20);
    const uncompressedSize = readUInt32LE(input, offset + 24);
    const nameLength = readUInt16LE(input, offset + 28);
    const extraLength = readUInt16LE(input, offset + 30);
    const commentLength = readUInt16LE(input, offset + 32);
    const localHeaderOffset = readUInt32LE(input, offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    ensureRange(input, nameStart, nameLength);
    const name = decodeEntryName(input.subarray(nameStart, nameEnd), flags);

    if ((flags & 0x1) !== 0) {
      throw new ZipReadError('encrypted_input', `ZIP entry "${name}" is encrypted`);
    }
    if (compressedSize === ZIP64_SENTINEL_32 || uncompressedSize === ZIP64_SENTINEL_32) {
      throw new ZipReadError('unsupported_format', `ZIP64 entry "${name}" is not supported`);
    }
    totalUncompressed += uncompressedSize;
    if (uncompressedSize > maxUncompressedBytes || totalUncompressed > maxUncompressedBytes) {
      throw new ZipReadError(
        'file_too_large',
        `ZIP entry "${name}" exceeds max uncompressed size ${maxUncompressedBytes}`
      );
    }

    const data = readLocalEntry(input, {
      name,
      flags,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    entries.set(name, { name, data });
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

function readLocalEntry(
  input: Uint8Array,
  entry: {
    name: string;
    flags: number;
    method: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
  }
): Uint8Array {
  const offset = entry.localHeaderOffset;
  if (readUInt32LE(input, offset) !== LOCAL_FILE_SIGNATURE) {
    throw new ZipReadError('corrupt_input', `Invalid ZIP local header for "${entry.name}"`);
  }
  const localNameLength = readUInt16LE(input, offset + 26);
  const localExtraLength = readUInt16LE(input, offset + 28);
  const dataStart = offset + 30 + localNameLength + localExtraLength;
  ensureRange(input, dataStart, entry.compressedSize);
  const compressed = input.subarray(dataStart, dataStart + entry.compressedSize);

  let data: Uint8Array;
  switch (entry.method) {
    case 0:
      data = compressed;
      break;
    case 8:
      // Bound decompression to the entry's declared `uncompressedSize`. Without the
      // cap, a crafted ZIP entry with a tiny compressedSize / large
      // uncompressedSize-claim could still inflate past the declared size and
      // exhaust memory before the post-decode size check fires. With this cap
      // inflateRawSync throws when the stream tries to exceed the declared size,
      // converting silent OOM into a parse-error.
      data = new Uint8Array(
        inflateRawSync(compressed, { maxOutputLength: entry.uncompressedSize })
      );
      break;
    default:
      throw new ZipReadError(
        'unsupported_format',
        `ZIP entry "${entry.name}" uses unsupported compression method ${entry.method}`
      );
  }

  if (entry.uncompressedSize > 0 && data.byteLength !== entry.uncompressedSize) {
    throw new ZipReadError(
      'corrupt_input',
      `ZIP entry "${entry.name}" size mismatch: expected ${entry.uncompressedSize}, got ${data.byteLength}`
    );
  }
  return data;
}

function findEndOfCentralDirectory(input: Uint8Array): number {
  const minOffset = Math.max(0, input.byteLength - 65_557);
  for (let offset = input.byteLength - 22; offset >= minOffset; offset -= 1) {
    if (readUInt32LE(input, offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  throw new ZipReadError('corrupt_input', 'Could not find ZIP end-of-central-directory record');
}

function decodeEntryName(input: Uint8Array, flags: number): string {
  if ((flags & 0x800) !== 0) {
    return new TextDecoder('utf-8', { fatal: false }).decode(input);
  }
  return Buffer.from(input).toString('latin1');
}

function readUInt16LE(input: Uint8Array, offset: number): number {
  ensureRange(input, offset, 2);
  return input[offset]! | (input[offset + 1]! << 8);
}

function readUInt32LE(input: Uint8Array, offset: number): number {
  ensureRange(input, offset, 4);
  return (
    (input[offset]! |
      (input[offset + 1]! << 8) |
      (input[offset + 2]! << 16) |
      (input[offset + 3]! << 24)) >>>
    0
  );
}

function ensureRange(input: Uint8Array, offset: number, length: number): void {
  if (offset < 0 || length < 0 || offset + length > input.byteLength) {
    throw new ZipReadError('corrupt_input', 'ZIP structure points outside the input buffer');
  }
}
