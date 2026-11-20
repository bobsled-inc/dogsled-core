/**
 * Object metadata for the files a copy writes to S3 and GCS.
 *
 * S3 allows at most 2 KB of user-defined metadata on an object, counted as the bytes of every key
 * and every value, and it stores only US-ASCII. A copy applies the same limit to GCS, so a
 * Resource that works on one also works on the other. The loader writes each value percent-encoded
 * (see `encodeMetadataValue`); a reader decodes it with `decodeURIComponent`.
 */

/** The most bytes of keys and encoded values one object may carry. */
export const OBJECT_METADATA_MAX_BYTES = 2048;

/**
 * S3 does not say whether its 2 KB counts the `x-amz-meta-` that starts each key on the wire, so
 * each key counts it. That costs a few bytes, and a write that S3 turns away would stop every run.
 */
const KEY_PREFIX_BYTES = 'x-amz-meta-'.length;

/** The key a copy sets to the file's key in the source. */
export const COPY_METADATA_SOURCE_KEY = 'dogsled-source';

/** The key a copy sets to the time the source says the file was modified. */
export const COPY_METADATA_MODIFIED_KEY = 'dogsled-source-modified';

const KEY_PATTERN = /^[a-z0-9-]+$/;
const RESERVED_KEYS: ReadonlySet<string> = new Set([
  COPY_METADATA_SOURCE_KEY,
  COPY_METADATA_MODIFIED_KEY,
]);

const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).length;

/** Letters, digits and these marks pass through unchanged. Every other byte becomes `%XX`. */
const SAFE_BYTE = /[A-Za-z0-9\-_.~/:]/;

/**
 * The US-ASCII form of a metadata value: each byte of its UTF-8 form that is not a letter, a digit
 * or one of `-_.~/:` becomes `%XX`. `decodeURIComponent` reverses it.
 */
export function encodeMetadataValue(value: string): string {
  let encoded = '';
  for (const byte of encoder.encode(value)) {
    const character = String.fromCharCode(byte);
    encoded +=
      byte < 0x80 && SAFE_BYTE.test(character)
        ? character
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return encoded;
}

/**
 * The bytes these entries take on an object: every key with its prefix, and every value in its
 * encoded form.
 */
export function objectMetadataBytes(metadata: Readonly<Record<string, string>>): number {
  let total = 0;
  for (const [key, value] of Object.entries(metadata)) {
    total += KEY_PREFIX_BYTES + byteLength(key) + byteLength(encodeMetadataValue(value));
  }
  return total;
}

// A copy adds both keys, and the modified time the extractor sends is 24 bytes
// (`2026-11-20T15:24:53.408Z`). The source key varies from file to file, so it has no room set
// aside: the loader leaves it out of a file whose key does not fit.
const COPY_ADDED_BYTES = objectMetadataBytes({
  [COPY_METADATA_SOURCE_KEY]: '',
  [COPY_METADATA_MODIFIED_KEY]: '2026-11-20T15:24:53.408Z',
});

/** Why `value` cannot be the `object_metadata` of a destination, or undefined if it can. */
export function objectMetadataProblem(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'must be an object of text values';
  }
  const metadata: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!KEY_PATTERN.test(key)) {
      return `the key ${JSON.stringify(key)} must use only lowercase letters, digits and dashes`;
    }
    if (RESERVED_KEYS.has(key)) {
      return `the key "${key}" is set by a copy, so it cannot be set here`;
    }
    if (typeof entry !== 'string') {
      return `the value of "${key}" must be text`;
    }
    if (entry.length === 0) {
      return `the value of "${key}" must not be empty`;
    }
    metadata[key] = entry;
  }
  const total = objectMetadataBytes(metadata) + COPY_ADDED_BYTES;
  if (total > OBJECT_METADATA_MAX_BYTES) {
    return (
      `must be at most ${OBJECT_METADATA_MAX_BYTES} bytes, counting each key with S3's ` +
      `${KEY_PREFIX_BYTES}-byte prefix and each value percent-encoded, and it is ${total} with ` +
      'the two keys and the modified time a copy adds'
    );
  }
  return undefined;
}
