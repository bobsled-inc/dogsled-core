import { getEncoding, type Tiktoken } from 'js-tiktoken';

import type { Chunk, ChunkOptions } from '../types.js';

/**
 * Recursive token-aware splitter. Walks a hierarchy of separators (paragraph break →
 * line break → sentence end → space → character) to find the coarsest split that fits
 * each chunk under `maxTokens`. Adds backward-token overlap between adjacent chunks for
 * recall.
 *
 * Determinism: the same input + same ChunkOptions always produce the same chunks
 * (proven by tests in `tests/chunkers/recursive.test.ts`).
 *
 * Tokenizer instances are reused across calls to avoid the ~50ms cold-start cost
 * documented in the unstructured-data plan's research notes.
 */

const SEPARATORS = ['\n\n', '\n', '. ', '? ', '! ', '; ', ', ', ' ', ''] as const;

const tokenizerCache = new Map<ChunkOptions['tokenizer'], Tiktoken>();

export function getTokenizer(name: ChunkOptions['tokenizer']): Tiktoken {
  let enc = tokenizerCache.get(name);
  if (!enc) {
    enc = getEncoding(name);
    tokenizerCache.set(name, enc);
  }
  return enc;
}

export function chunkRecursive(text: string, opts: ChunkOptions): Chunk[] {
  if (text.length === 0) return [];
  // Schema (DocumentChunkConfigSchema) enforces overlapTokens < maxTokens at YAML load
  // time. Library callers that bypass the schema get a defensive runtime check too:
  if (opts.overlapTokens >= opts.maxTokens) {
    throw new Error(
      `chunk.overlap_tokens (${opts.overlapTokens}) must be less than chunk.max_tokens (${opts.maxTokens})`
    );
  }
  const enc = getTokenizer(opts.tokenizer);
  // Reserve `overlapTokens` of the per-chunk budget for the prefix added by
  // `applyOverlap`. Without this reservation, an overlap-prepended chunk could exceed
  // `maxTokens` and push downstream embedding calls past their model limits.
  const splitBudget = opts.overlapTokens > 0 ? opts.maxTokens - opts.overlapTokens : opts.maxTokens;
  const root = splitRecursive(text, enc, splitBudget, 0);
  return applyOverlap(root, enc, opts);
}

/**
 * Split text on `sep` while keeping the separator attached to each preceding segment
 * (except the last). Without this, the chunker drops the joining separator when it
 * pushes a `buffer` mid-loop — `"A. B"` could become chunks `["A", "B"]` and lose the
 * `". "` boundary, mutating both embedding input and `chunk_id` content.
 */
function splitKeepingSeparator(text: string, sep: string): string[] {
  const parts = text.split(sep);
  if (parts.length <= 1) return [text];

  const out: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    const segment = i < parts.length - 1 ? `${part}${sep}` : part;
    if (segment.length > 0) out.push(segment);
  }
  return out;
}

export function splitRecursive(
  text: string,
  enc: Tiktoken,
  maxTokens: number,
  separatorIndex: number,
  splitFinest: (text: string, enc: Tiktoken, maxTokens: number) => string[] = splitByCharacters
): string[] {
  const tokens = enc.encode(text);
  if (tokens.length <= maxTokens) return [text];

  for (let i = separatorIndex; i < SEPARATORS.length; i += 1) {
    const sep = SEPARATORS[i]!;
    const segments =
      sep === '' ? splitFinest(text, enc, maxTokens) : splitKeepingSeparator(text, sep);
    if (segments.length <= 1) continue;

    const out: string[] = [];
    let buffer = '';
    let bufferTokens = 0;

    for (const segment of segments) {
      // Each non-final segment already carries its trailing separator (see
      // splitKeepingSeparator), so simple concatenation rebuilds the original text.
      const candidate = buffer ? buffer + segment : segment;
      const candidateTokens = enc.encode(candidate).length;
      if (candidateTokens <= maxTokens) {
        buffer = candidate;
        bufferTokens = candidateTokens;
        continue;
      }
      if (buffer) {
        out.push(buffer);
        buffer = '';
        bufferTokens = 0;
      }
      const segmentTokens = enc.encode(segment).length;
      if (segmentTokens <= maxTokens) {
        buffer = segment;
        bufferTokens = segmentTokens;
      } else {
        // Segment alone is over budget — recurse with the next finer separator.
        for (const sub of splitRecursive(segment, enc, maxTokens, i + 1, splitFinest)) {
          out.push(sub);
        }
      }
    }
    if (buffer && bufferTokens > 0) out.push(buffer);
    return out.filter((s) => s.length > 0);
  }
  return [text];
}

function splitByCharacters(text: string, enc: Tiktoken, maxTokens: number): string[] {
  // Last-resort fallback: greedily slice by token-count rather than character.
  const tokens = enc.encode(text);
  const out: string[] = [];
  let cursor = 0;
  while (cursor < tokens.length) {
    const slice = tokens.slice(cursor, cursor + maxTokens);
    out.push(enc.decode(slice));
    cursor += maxTokens;
  }
  return out;
}

function applyOverlap(segments: string[], enc: Tiktoken, opts: ChunkOptions): Chunk[] {
  if (segments.length === 0) return [];
  const out: Chunk[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    let body = segments[i]!;
    if (i > 0 && opts.overlapTokens > 0) {
      const prev = segments[i - 1]!;
      const prevTokens = enc.encode(prev);
      const tail = prevTokens.slice(Math.max(0, prevTokens.length - opts.overlapTokens));
      const overlap = enc.decode(tail);
      body = `${overlap}${overlap.endsWith('\n') ? '' : ' '}${body}`;
    }
    const tokenCount = enc.encode(body).length;
    out.push({ chunkIndex: i, text: body, tokenCount });
  }
  return out;
}

/**
 * Algorithm version token embedded in `chunkerConfigHash`. Bump when changing
 * separator order, overlap semantics, normalization logic, or any code path that
 * affects which chunks the splitter produces — not just when the public option
 * fields change. The hash gates cache invalidation, so consumer caches stay valid
 * across server restarts but invalidate on chunker upgrades.
 */
export const CHUNKER_VERSION = 'recursive:1.0.1';

/** Canonical form of the options that decide this strategy's chunks. */
export function recursiveConfig(opts: ChunkOptions): string {
  return `${CHUNKER_VERSION}::${opts.maxTokens}::${opts.overlapTokens}::${opts.tokenizer}`;
}
