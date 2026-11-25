import { beforeEach, describe, expect, it, vi } from 'vitest';

import { prepareEmbeddingText } from '../../../src/runtime/embedding-text.js';
import { truncateToTokens } from '../../../src/runtime/tokenizer.js';

vi.mock('../../../src/runtime/tokenizer.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/runtime/tokenizer.js')>();
  return { ...original, truncateToTokens: vi.fn(original.truncateToTokens) };
});

const countTokens = vi.mocked(truncateToTokens);
beforeEach(() => {
  countTokens.mockClear();
});

describe('a text for a host-supplied model', () => {
  // A token is at least one byte, so these cannot be over 8,191 tokens.
  it.each([
    ['8,191 one-byte characters', 'ab '.repeat(2_730) + 'a'],
    ['4,095 two-byte characters', 'é'.repeat(4_095)],
    ['2,730 three-byte characters', '犬'.repeat(2_730)],
    ['2,047 four-byte characters', '\u{1F6F7}'.repeat(2_047)],
  ])('is not tokenized at %s', (_label, text) => {
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8_191);
    expect(prepareEmbeddingText(text, { maxCharacters: 32_000 })).toEqual({ text });
    expect(countTokens).not.toHaveBeenCalled();
  });

  it.each([
    ['8,192 one-byte characters', 'ab '.repeat(2_730) + 'ab'],
    ['5,462 characters of 8,193 bytes', 'é '.repeat(2_731)],
  ])('is tokenized at %s', (_label, text) => {
    expect(Buffer.byteLength(text)).toBeGreaterThan(8_191);
    expect(prepareEmbeddingText(text, { maxCharacters: 32_000 })).toEqual({ text });
    expect(countTokens).toHaveBeenCalledTimes(1);
  });

  it('is cut to the character limit before it is measured', () => {
    // Counting the tokens of this run takes minutes, because it has no spaces.
    const run = 'a'.repeat(200_000);
    expect(prepareEmbeddingText(run, { maxCharacters: 8_000 })).toEqual({
      text: 'a'.repeat(8_000),
      truncation: { originalCharacters: 200_000 },
    });
    expect(countTokens).not.toHaveBeenCalled();
  });

  it('is cut to the token limit after the character limit', () => {
    const { text, truncation } = prepareEmbeddingText('word '.repeat(10_000), {
      maxCharacters: 45_000,
    });
    expect(countTokens.mock.calls[0]![0]).toHaveLength(45_000);
    expect(text!.length).toBeLessThan(45_000);
    expect(truncation).toEqual({ originalCharacters: 50_000, originalTokens: expect.any(Number) });
  });
});

describe('a text that a cut leaves blank, for a host-supplied model', () => {
  it('has nothing to embed after the character limit', () => {
    expect(prepareEmbeddingText(`${' '.repeat(40)}word`, { maxCharacters: 40 })).toEqual({
      text: null,
      truncation: { originalCharacters: 44 },
    });
    expect(countTokens).not.toHaveBeenCalled();
  });

  it('has nothing to embed after the token limit', () => {
    // Counting the tokens of a real run of whitespace this long takes minutes.
    const text = '\n'.repeat(8_191);
    countTokens.mockReturnValueOnce({
      text,
      truncated: true,
      originalTokens: 8_192,
      truncatedTokens: 8_191,
    });
    expect(prepareEmbeddingText(`${text}word`, { maxCharacters: 32_000 })).toEqual({
      text: null,
      truncation: { originalTokens: 8_192 },
    });
  });
});

describe('a text for any other provider', () => {
  it.each(['a', ' ', 'a'.repeat(100)])('is tokenized as it is: %j', (text) => {
    expect(prepareEmbeddingText(text)).toEqual({ text });
    expect(countTokens).toHaveBeenCalledWith(text, 8_191);
  });

  it.each([null, undefined, ''])('is nothing for %j', (value) => {
    expect(prepareEmbeddingText(value)).toEqual({ text: null });
    expect(countTokens).not.toHaveBeenCalled();
  });
});
