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
