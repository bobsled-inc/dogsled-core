import { MAX_EMBEDDING_TOKENS, truncateToCharacters, truncateToTokens } from './tokenizer.js';

/** What a host-supplied model adds to the token limit that every text has. */
export interface HostTextRules {
  /** The most UTF-16 units of one text. */
  maxCharacters?: number;
}

/** How a text was shortened. Each number is the length before that cut. */
export interface TextTruncation {
  originalTokens?: number;
  originalCharacters?: number;
}

export interface EmbeddingText {
  /** `null` when there is nothing to embed. */
  text: string | null;
  truncation?: TextTruncation;
}

/** The text to embed for a field value, within the token limit and a host's rules. */
export function prepareEmbeddingText(value: unknown, hostRules?: HostTextRules): EmbeddingText {
  if (value === null || value === undefined || value === '') return { text: null };
  return hostRules ? prepareHostText(String(value), hostRules) : cutToTokens(String(value), {});
}

/** Whitespace has nothing to embed, as the empty string has not. */
function prepareHostText(original: string, { maxCharacters }: HostTextRules): EmbeddingText {
  if (original.trim() === '') return { text: null };

  const truncation: TextTruncation = {};
  let text = original;
  if (maxCharacters !== undefined && text.length > maxCharacters) {
    truncation.originalCharacters = text.length;
    text = truncateToCharacters(text, maxCharacters);
  }
  // A cut can leave nothing but the whitespace a text starts with.
  if (text.trim() === '') return { text: null, truncation };
  // A token is at least one byte, so a short text needs no counting, which is slow for text
  // without spaces.
  if (Buffer.byteLength(text) <= MAX_EMBEDDING_TOKENS) return withTruncation(text, truncation);
  const cut = cutToTokens(text, truncation);
  return cut.text?.trim() === '' ? { ...cut, text: null } : cut;
}

function cutToTokens(original: string, truncation: TextTruncation): EmbeddingText {
  const tokens = truncateToTokens(original, MAX_EMBEDDING_TOKENS);
  return withTruncation(
    tokens.text,
    tokens.truncated ? { ...truncation, originalTokens: tokens.originalTokens } : truncation
  );
}

function withTruncation(text: string, truncation: TextTruncation): EmbeddingText {
  return Object.keys(truncation).length > 0 ? { text, truncation } : { text };
}
