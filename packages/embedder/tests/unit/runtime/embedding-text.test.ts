import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prepareEmbeddingText, truncateToCharacters } from '../../../src/runtime/embedding-text.js';
import { truncateToTokens } from '../../../src/runtime/tokenizer.js';

vi.mock('../../../src/runtime/tokenizer.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/runtime/tokenizer.js')>();
  return { ...original, truncateToTokens: vi.fn(original.truncateToTokens) };
});

const tokenize = vi.mocked(truncateToTokens);
beforeEach(() => {
  tokenize.mockClear();
});

describe('a text for a host-supplied model', () => {
  beforeEach(() => {
    tokenize.mockImplementation(() => {
      throw new Error('The text was tokenized.');
    });
  });
  afterEach(() => {
    tokenize.mockReset();
  });

  it.each([
    ['a long text', 'word '.repeat(20_000)],
    ['a long text with many tokens for each character', '犬'.repeat(30_000)],
    ['a long text without spaces', 'a'.repeat(200_000)],
    ['a long text with a token marker', `<|endoftext|>${' word'.repeat(20_000)}`],
  ])('is left to the host within its limit: %s', (_label, text) => {
    expect(prepareEmbeddingText(text, { maxCharacters: 200_000 })).toEqual({ text });
    expect(prepareEmbeddingText(text, {})).toEqual({ text });
  });

  it('is cut to the character limit only', () => {
    expect(prepareEmbeddingText('犬'.repeat(40_000), { maxCharacters: 32_000 })).toEqual({
      text: '犬'.repeat(32_000),
      truncation: { unit: 'characters', limit: 32_000, originalLength: 40_000 },
    });
  });

  it.each(['', ' ', '\n\t ', ' 　', ' '.repeat(50)])(
    'is nothing when it is blank, whatever its length: %j',
    (text) => {
      expect(prepareEmbeddingText(text, { maxCharacters: 40 })).toEqual({ text: null });
    }
  );

  it('is nothing when the cut leaves it blank, and says that it was cut', () => {
    expect(prepareEmbeddingText(`${' '.repeat(40)}word`, { maxCharacters: 40 })).toEqual({
      text: null,
      truncation: { unit: 'characters', limit: 40, originalLength: 44 },
    });
  });
});

describe('a text for any other provider', () => {
  it.each(['a', ' ', 'a'.repeat(100)])('is tokenized as it is: %j', (text) => {
    expect(prepareEmbeddingText(text)).toEqual({ text });
    expect(tokenize).toHaveBeenCalledWith(text, 8_191);
  });

  it('is cut to the token limit', () => {
    const { text, truncation } = prepareEmbeddingText('word '.repeat(10_000));
    expect(text!.length).toBeLessThan(50_000);
    expect(truncation).toEqual({
      unit: 'tokens',
      limit: 8_191,
      originalLength: tokenize.mock.results[0]!.value.originalTokens,
    });
  });

  it.each([null, undefined, ''])('is nothing for %j', (value) => {
    expect(prepareEmbeddingText(value)).toEqual({ text: null });
    expect(tokenize).not.toHaveBeenCalled();
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
    ['abc', Infinity, 'abc'],
    // A lone half is not a pair, so there is nothing to keep together.
    ['ab\ud83dc', 3, 'ab\ud83d'],
    ['ab\udef7c', 3, 'ab\udef7'],
  ])('cuts %j at %d', (text, max, expected) => {
    expect(truncateToCharacters(text, max)).toBe(expected);
  });
});
