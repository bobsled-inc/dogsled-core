import { getEncoding } from 'js-tiktoken';
import { describe, expect, it, vi } from 'vitest';

import { getTokenizer } from '../src/chunkers/recursive.js';
import { chunkText, chunkerConfigHash, type ChunkOptions } from '../src/index.js';

const opts = {
  strategy: 'paragraph',
  maxTokens: 20,
  minTokens: 8,
  overlapTokens: 0,
  tokenizer: 'cl100k_base',
} as const satisfies ChunkOptions;

const enc = getEncoding('cl100k_base');
const tokens = (text: string): number => enc.encode(text).length;
/** A paragraph of exactly `count` tokens. */
const words = (count: number): string => `one${' two'.repeat(count - 1)}`;
const texts = (text: string, overrides: Partial<ChunkOptions> = {}): string[] =>
  chunkText(text, { ...opts, ...overrides }).map((chunk) => chunk.text);
const visible = (text: string): string => text.replace(/\s+/g, '');

describe('paragraph chunker', () => {
  it('returns nothing for text without visible characters', () => {
    expect(texts('')).toEqual([]);
    expect(texts(' \n\n\t\n ')).toEqual([]);
  });

  it('cuts at blank lines and keeps single line breaks', () => {
    const a = `${words(6)}\n${words(6)}`;
    const b = words(10);
    expect(tokens(words(10))).toBe(10);
    expect(texts(`${a}\n\n${b}`)).toEqual([a, b]);
    expect(texts(`${a}\n \t\n\n${b}\n`)).toEqual([a, b]);
    expect(texts(`${a}\r\n\r\n${b}`)).toEqual([a, b]);
  });

  it('joins paragraphs only until min tokens, with the original text between them', () => {
    expect(texts(`Title\n\n \n${words(7)}\n\n${words(9)}\n\n${words(9)}`)).toEqual([
      `Title\n\n \n${words(7)}`,
      words(9),
      words(9),
    ]);
  });

  it('stops at exactly min tokens', () => {
    expect(texts(`${words(8)}\n\n${words(8)}`)).toEqual([words(8), words(8)]);
    expect(texts(`${words(7)}\n\n${words(8)}\n\n${words(8)}`)).toEqual([
      `${words(7)}\n\n${words(8)}`,
      words(8),
    ]);
  });

  it('does not join above max tokens', () => {
    const fits = `${words(7)}\n\n${words(12)}`;
    expect(tokens(fits)).toBe(20);
    expect(texts(fits)).toEqual([fits]);
    expect(texts(`${words(7)}\n\n${words(13)}`)).toEqual([words(7), words(13)]);
  });

  it('joins a short tail to the previous chunk when it fits, else leaves it alone', () => {
    expect(texts(`${words(10)}\n\n${words(9)}`)).toHaveLength(2);
    expect(texts(`${words(10)}\n\n${words(3)}`)).toEqual([`${words(10)}\n\n${words(3)}`]);
    expect(texts(`${words(18)}\n\n${words(3)}`)).toEqual([words(18), words(3)]);
    expect(texts(words(3))).toEqual([words(3)]);
  });

  it('cuts a paragraph above max tokens with the recursive splitter', () => {
    const long = 'A short sentence here. '.repeat(20).trim();
    const chunks = texts(`${words(9)}\n\n${long}\n\n${words(9)}`);
    const recursive = chunkText(long, {
      maxTokens: 20,
      overlapTokens: 0,
      tokenizer: 'cl100k_base',
    }).map((chunk) => chunk.text);
    expect(recursive.length).toBeGreaterThan(2);
    expect(chunks).toEqual([words(9), ...recursive, words(9)]);
  });

  it('joins a short tail to the last piece of a long paragraph', () => {
    const long = `${words(20)}. ${words(5)}`;
    expect(texts(`${long}\n\n${words(3)}`).at(-1)).toBe(`${words(5)}\n\n${words(3)}`);
  });

  it('keeps every character of long text without separators', () => {
    for (const text of ['漢字仮名交文'.repeat(60), '\u{1F680}\u{1F9EA}'.repeat(60)]) {
      const chunks = chunkText(text, opts);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.map((chunk) => chunk.text).join('')).toBe(text);
      for (const chunk of chunks) expect(chunk.tokenCount).toBeLessThanOrEqual(opts.maxTokens);
    }
  });

  it.each(['cl100k_base', 'o200k_base', 'p50k_base'] as const)(
    'covers all visible text in order within max tokens with %s',
    (tokenizer) => {
      const parts = ['alpha', 'end.', '"quoted"', '12,345', '日本語', '!!!', '\u{1F680}', '  in;'];
      const breaks = ['\n\n', '\n\n\n', '\n \n', '\r\n\r\n', '\n', ' ', ' ', ' '];
      let seed = 0x5eed;
      const next = (): number => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 8;
      const encoding = getEncoding(tokenizer);
      for (let run = 0; run < 60; run += 1) {
        let text = '';
        for (let i = 0; i < 10 + (next() % 150); i += 1) {
          text += parts[next() % parts.length]! + breaks[next() % breaks.length]!;
        }
        const chunks = chunkText(text, { ...opts, tokenizer });
        expect(chunkText(text, { ...opts, tokenizer })).toEqual(chunks);
        expect(visible(chunks.map((chunk) => chunk.text).join(''))).toBe(visible(text));
        chunks.forEach((chunk, index) => {
          expect(chunk.chunkIndex).toBe(index);
          expect(chunk.tokenCount).toBe(encoding.encode(chunk.text).length);
          expect(chunk.tokenCount).toBeLessThanOrEqual(opts.maxTokens);
        });
      }
    }
  );

  it.each([
    ['one-character paragraphs', 'a\n\n', 60],
    ['one-character paragraphs with a large minimum', 'a\n\n', 800],
    ['sentences', 'The quick brown fox jumps over the lazy dog.\n\n', 800],
  ])('encodes a bounded multiple of the text for %s', (_name, unit, minTokens) => {
    const text = unit.repeat(Math.ceil(200_000 / unit.length));
    const encode = vi.spyOn(getTokenizer('cl100k_base'), 'encode');
    try {
      chunkText(text, { ...opts, maxTokens: 800, minTokens });
      const encoded = encode.mock.calls.reduce((sum, [value]) => sum + value.length, 0);
      expect(encoded).toBeLessThan(text.length * 12);
      expect(encode.mock.calls.length).toBeLessThan((text.length / unit.length) * 2);
    } finally {
      encode.mockRestore();
    }
  });

  it('defaults min tokens to 60, or max tokens when that is smaller', () => {
    const text = Array.from({ length: 40 }, () => words(10)).join('\n\n');
    const { minTokens: _, ...noMin } = { ...opts, maxTokens: 800 };
    expect(chunkText(text, noMin)).toEqual(chunkText(text, { ...noMin, minTokens: 60 }));
    expect(chunkerConfigHash(noMin)).toBe(chunkerConfigHash({ ...noMin, minTokens: 60 }));
    const small = { ...noMin, maxTokens: 30 };
    expect(chunkText(text, small)).toEqual(chunkText(text, { ...small, minTokens: 30 }));
  });

  it('rejects overlap and a minimum outside 1 to max tokens', () => {
    expect(() => texts('hi', { overlapTokens: 1 })).toThrow(/overlap_tokens must be 0/);
    for (const minTokens of [0, -1, 1.5, 21]) {
      expect(() => texts('hi', { minTokens })).toThrow(/min_tokens/);
    }
  });

  it('hashes every option and differs from the recursive hash', () => {
    const base: ChunkOptions = { ...opts, maxTokens: 800, minTokens: 60 };
    const variants: ChunkOptions[] = [
      base,
      { ...base, minTokens: 61 },
      { ...base, maxTokens: 801 },
      { ...base, tokenizer: 'o200k_base' },
      { maxTokens: 800, overlapTokens: 0, tokenizer: 'cl100k_base' },
    ];
    expect(new Set(variants.map(chunkerConfigHash)).size).toBe(variants.length);
    expect(chunkerConfigHash(base)).toBe(chunkerConfigHash({ ...base }));
  });
});
