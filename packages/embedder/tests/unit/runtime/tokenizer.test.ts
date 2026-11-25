import { describe, expect, it } from 'vitest';

import {
  countTokens,
  MAX_EMBEDDING_TOKENS,
  truncateToCharacters,
  truncateToTokens,
} from '../../../src/runtime/tokenizer.js';

describe('tokenizer', () => {
  it('counts tokens for short text', () => {
    const count = countTokens('hello world');

    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(10);
  });

  it('leaves short text unchanged when truncating', () => {
    const result = truncateToTokens('hello world', 100);

    expect(result.text).toBe('hello world');
    expect(result.truncated).toBe(false);
    expect(result.originalTokens).toBe(result.truncatedTokens);
  });

  it('truncates text exceeding the limit', () => {
    const longText = 'word '.repeat(5_000);
    const result = truncateToTokens(longText, 100);

    expect(result.truncated).toBe(true);
    expect(result.originalTokens).toBeGreaterThan(100);
    expect(result.truncatedTokens).toBe(100);
    expect(countTokens(result.text)).toBeLessThanOrEqual(100);
  });

  it('keeps text unchanged when maxTokens equals token count', () => {
    const text = 'hello world';
    const maxTokens = countTokens(text);
    const result = truncateToTokens(text, maxTokens);

    expect(result.truncated).toBe(false);
    expect(result.text).toBe(text);
    expect(result.originalTokens).toBe(maxTokens);
    expect(result.truncatedTokens).toBe(maxTokens);
  });

  it('returns empty text when token budget is zero', () => {
    const result = truncateToTokens('hello world', 0);

    expect(result.truncated).toBe(true);
    expect(result.text).toBe('');
    expect(result.originalTokens).toBeGreaterThan(0);
    expect(result.truncatedTokens).toBe(0);
    expect(countTokens(result.text)).toBe(0);
  });

  it('uses the current OpenAI embedding token limit', () => {
    // Pin the current upstream limit so accidental tokenizer regressions are loud.
    expect(MAX_EMBEDDING_TOKENS).toBe(8191);
  });
});

describe('truncateToCharacters', () => {
  it.each([
    ['abc', 3, 'abc'],
    ['abcd', 3, 'abc'],
    ['ab\u{1F6F7}', 4, 'ab\u{1F6F7}'],
    ['ab\u{1F6F7}', 3, 'ab'],
    ['ab\u{1F6F7}c', 4, 'ab\u{1F6F7}'],
    ['\u{1F6F7}', 1, ''],
    // A lone half is not a pair, so there is nothing to keep together.
    ['ab\ud83dc', 3, 'ab\ud83d'],
    ['ab\udef7c', 3, 'ab\udef7'],
  ])('cuts %j at %i', (text, max, expected) => {
    expect(truncateToCharacters(text, max)).toBe(expected);
  });
});
