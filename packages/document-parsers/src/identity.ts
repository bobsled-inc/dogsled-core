import { createHash } from 'node:crypto';

/**
 * Three-tier deterministic identity scheme for documents and chunks.
 * Part of the Document Stream Schema Contract.
 *
 *   document_id          = sha256(source_uri)
 *   document_version_id  = sha256(source_uri::content_hash::source_revision)
 *   chunk_id             = sha256(document_version_id::chunker_config_hash::chunk_index::chunk_text)
 *
 * Stable across x64/arm64 (Node's crypto module produces identical bytes regardless of
 * host architecture). The canonical form joins inputs with `'::'` separators; chunk_text
 * is included raw (not pre-hashed) so the form matches the contract verbatim.
 */

const SEP = '::';

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function documentId(sourceUri: string): string {
  return sha256(sourceUri);
}

export function documentVersionId(args: {
  sourceUri: string;
  contentHash: string;
  sourceRevision?: string;
}): string {
  const revision = args.sourceRevision ?? '';
  return sha256([args.sourceUri, args.contentHash, revision].join(SEP));
}

export function chunkId(args: {
  documentVersionId: string;
  chunkerConfigHash: string;
  chunkIndex: number;
  chunkText: string;
}): string {
  return sha256(
    [args.documentVersionId, args.chunkerConfigHash, String(args.chunkIndex), args.chunkText].join(
      SEP
    )
  );
}

/** Convenience: SHA-256 of arbitrary text, hex-encoded. Used by callers that need to
 *  hash file bytes for content_hash or hash chunk text for cache keys. */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256')
    .update(typeof input === 'string' ? input : Buffer.from(input))
    .digest('hex');
}
