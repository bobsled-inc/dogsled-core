import { getEncoding } from 'js-tiktoken';

export const MAX_EMBEDDING_TOKENS = 8191;

const encoding = getEncoding('cl100k_base');

export interface TruncateResult {
  text: string;
  truncated: boolean;
  originalTokens: number;
  truncatedTokens: number;
}

export function countTokens(text: string): number {
  return encoding.encode(text).length;
}

export function truncateToTokens(text: string, maxTokens: number): TruncateResult {
  const tokens = encoding.encode(text);

  if (tokens.length <= maxTokens) {
    return {
      text,
      truncated: false,
      originalTokens: tokens.length,
      truncatedTokens: tokens.length,
    };
  }

  const truncatedTokenSlice = tokens.slice(0, maxTokens);
  return {
    text: encoding.decode(truncatedTokenSlice),
    truncated: true,
    originalTokens: tokens.length,
    truncatedTokens: maxTokens,
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
