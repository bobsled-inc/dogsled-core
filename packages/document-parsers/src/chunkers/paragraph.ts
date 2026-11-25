import type { Chunk, ChunkOptions } from '../types.js';

import { CHUNKER_VERSION, getTokenizer, splitRecursive } from './recursive.js';

const DEFAULT_MIN_TOKENS = 60;

/** Bump when a change affects which chunks this strategy produces. See `CHUNKER_VERSION`. */
export const PARAGRAPH_CHUNKER_VERSION = 'paragraph:1.0.0';

interface Span {
  readonly start: number;
  readonly end: number;
}

/** Paragraphs being joined. `tokens` is an upper bound until `exact`. */
interface OpenChunk extends Span {
  readonly tokens: number;
  readonly exact: boolean;
}

interface ClosedChunk {
  readonly text: string;
  readonly tokens: number;
  /** Where the chunk's text ends in the document. */
  readonly end: number;
}

/**
 * Cut at blank lines, then join consecutive paragraphs until a chunk reaches `minTokens`,
 * never above `maxTokens`. A longer paragraph goes to the recursive splitter. Chunks keep
 * the text between joined paragraphs and leave out only the blank lines between chunks.
 *
 * Joined text is measured only when its upper bound reaches a limit: each paragraph's own
 * count plus one token per byte between them. Encoding the open chunk again for every
 * paragraph would be quadratic in documents made of very short ones.
 */
export function chunkParagraphs(text: string, opts: ChunkOptions): Chunk[] {
  const { maxTokens } = opts;
  const minTokens = resolveMinTokens(opts);
  const enc = getTokenizer(opts.tokenizer);
  const count = (value: string): number => enc.encode(value).length;
  const closed: ClosedChunk[] = [];
  let open: OpenChunk | null = null;

  const closeSplit = ({ start, end }: Span): void => {
    const parts = splitRecursive(
      text.slice(start, end),
      enc,
      maxTokens,
      0,
      splitByCodePoints
    ).filter((part) => part.trim().length > 0);
    for (const part of parts) closed.push({ text: part, tokens: count(part), end });
  };
  const close = (chunk: OpenChunk): void => {
    const body = text.slice(chunk.start, chunk.end);
    const tokens = chunk.exact ? chunk.tokens : count(body);
    if (tokens > maxTokens) closeSplit(chunk);
    else closed.push({ text: body, tokens, end: chunk.end });
  };

  /** The open chunk with one more paragraph, or null when that passes `maxTokens`. */
  const join = (current: OpenChunk, paragraph: Span, paragraphTokens: number): OpenChunk | null => {
    const { start } = current;
    const { end } = paragraph;
    const between = Buffer.byteLength(text.slice(current.end, paragraph.start));
    const bound = current.tokens + between + paragraphTokens;
    if (bound < minTokens) return { start, end, tokens: bound, exact: false };
    const tokens = count(text.slice(start, end));
    return tokens <= maxTokens ? { start, end, tokens, exact: true } : null;
  };

  for (const paragraph of findParagraphs(text)) {
    const tokens = count(text.slice(paragraph.start, paragraph.end));
    if (tokens > maxTokens) {
      if (open) close(open);
      open = null;
      closeSplit(paragraph);
      continue;
    }
    const joined: OpenChunk | null = open && join(open, paragraph, tokens);
    if (open && !joined) close(open);
    open = joined ?? { ...paragraph, tokens, exact: true };
    if (open.exact && open.tokens >= minTokens) {
      close(open);
      open = null;
    }
  }

  if (open) {
    const last = closed.at(-1);
    const withLast = last && last.text + text.slice(last.end, open.end);
    const tokens = withLast === undefined ? Infinity : count(withLast);
    if (withLast !== undefined && tokens <= maxTokens) {
      closed[closed.length - 1] = { text: withLast, tokens, end: open.end };
    } else {
      close(open);
    }
  }
  return closed.map((chunk, chunkIndex) => ({
    chunkIndex,
    text: chunk.text,
    tokenCount: chunk.tokens,
  }));
}

/** Canonical form of the options that decide this strategy's chunks. */
export function paragraphConfig(opts: ChunkOptions): string {
  return [
    PARAGRAPH_CHUNKER_VERSION,
    CHUNKER_VERSION,
    opts.maxTokens,
    resolveMinTokens(opts),
    opts.tokenizer,
  ].join('::');
}

function resolveMinTokens(opts: ChunkOptions): number {
  if (opts.overlapTokens !== 0) {
    throw new Error('chunk.overlap_tokens must be 0 when chunk.strategy is paragraph');
  }
  const minTokens = opts.minTokens ?? Math.min(DEFAULT_MIN_TOKENS, opts.maxTokens);
  if (!Number.isInteger(minTokens) || minTokens < 1 || minTokens > opts.maxTokens) {
    throw new Error(
      `chunk.min_tokens (${minTokens}) must be a positive integer no larger than chunk.max_tokens (${opts.maxTokens})`
    );
  }
  return minTokens;
}

/** Runs of lines that are not blank, without the whitespace after the last one. */
function findParagraphs(text: string): Span[] {
  const paragraphs: Span[] = [];
  let start = -1;
  let end = -1;
  let lineStart = 0;
  while (lineStart < text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline < 0 ? text.length : newline;
    const length = text.slice(lineStart, lineEnd).trimEnd().length;
    if (length > 0) {
      if (start < 0) start = lineStart;
      end = lineStart + length;
    } else if (start >= 0) {
      paragraphs.push({ start, end });
      start = -1;
    }
    lineStart = lineEnd + 1;
  }
  if (start >= 0) paragraphs.push({ start, end });
  return paragraphs;
}

/**
 * Finest split for text without separators. Cutting between code points loses no text,
 * while cutting between tokens can break a character. A code point takes at most four
 * tokens, so each part fits, and the recursive splitter joins parts up to the limit.
 */
function splitByCodePoints(text: string, _enc: unknown, maxTokens: number): string[] {
  const size = Math.max(1, Math.floor(maxTokens / 16));
  const codePoints = Array.from(text);
  const parts: string[] = [];
  for (let i = 0; i < codePoints.length; i += size) {
    parts.push(codePoints.slice(i, i + size).join(''));
  }
  return parts;
}
