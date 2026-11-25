import { MAX_EMBEDDING_TOKENS, truncateToTokens } from './tokenizer.js';

/** What a host-supplied model sets for a text. Its host counts the tokens itself. */
export interface HostTextRules {
  /** The most UTF-16 units of one text. */
  maxCharacters?: number;
}

/** How a text was shortened. */
export interface TextTruncation {
  unit: 'tokens' | 'characters';
  limit: number;
  originalLength: number;
}

export interface EmbeddingText {
  /** `null` when there is nothing to embed. */
  text: string | null;
  truncation?: TextTruncation;
}

/**
 * The text to embed for a field value, within one limit: the host's own for a model it
 * supplies, which the bundled tokenizer knows nothing about, or a number of tokens.
 */
export function prepareEmbeddingText(value: unknown, hostRules?: HostTextRules): EmbeddingText {
  if (value === null || value === undefined || value === '') return { text: null };
  return hostRules ? cutToCharacters(String(value), hostRules) : cutToTokens(String(value));
}

/** Whitespace has nothing to embed, as the empty string has not. */
function cutToCharacters(
  original: string,
  { maxCharacters = Infinity }: HostTextRules
): EmbeddingText {
  if (original.trim() === '') return { text: null };
  const text = truncateToCharacters(original, maxCharacters);
  if (text === original) return { text };
  return {
    // A cut can leave nothing but the whitespace a text starts with.
    text: text.trim() === '' ? null : text,
    truncation: { unit: 'characters', limit: maxCharacters, originalLength: original.length },
  };
}

function cutToTokens(original: string): EmbeddingText {
  const { text, truncated, originalTokens } = truncateToTokens(original, MAX_EMBEDDING_TOKENS);
  if (!truncated) return { text };
  return {
    text,
    truncation: { unit: 'tokens', limit: MAX_EMBEDDING_TOKENS, originalLength: originalTokens },
  };
}

/** At most `maxCharacters` UTF-16 units of `text`, never half of a surrogate pair. */
export function truncateToCharacters(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) return text;
  const last = text.charCodeAt(maxCharacters - 1);
  const next = text.charCodeAt(maxCharacters);
  const splitsPair = last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
  return text.slice(0, splitsPair ? maxCharacters - 1 : maxCharacters);
}
