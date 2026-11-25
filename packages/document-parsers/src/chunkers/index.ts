import { createHash } from 'node:crypto';

import type { Chunk, ChunkOptions } from '../types.js';

import { chunkParagraphs, paragraphConfig } from './paragraph.js';
import { chunkRecursive, recursiveConfig } from './recursive.js';

export function chunkText(text: string, opts: ChunkOptions): Chunk[] {
  assertMinTokensAllowed(opts);
  return opts.strategy === 'paragraph' ? chunkParagraphs(text, opts) : chunkRecursive(text, opts);
}

/**
 * SHA-256 of canonicalized chunker config — stable identifier embedded in chunk_ids
 * (see Document Stream Schema Contract). When `ChunkOptions` change OR the strategy's
 * version is bumped, this hash changes and downstream consumers invalidate the cache.
 */
export function chunkerConfigHash(opts: ChunkOptions): string {
  assertMinTokensAllowed(opts);
  const canonical = opts.strategy === 'paragraph' ? paragraphConfig(opts) : recursiveConfig(opts);
  return createHash('sha256').update(canonical).digest('hex');
}

// The resource schema rejects this at load time; library callers bypass it.
function assertMinTokensAllowed(opts: ChunkOptions): void {
  if (opts.minTokens !== undefined && opts.strategy !== 'paragraph') {
    throw new Error('chunk.min_tokens requires chunk.strategy: paragraph');
  }
}
