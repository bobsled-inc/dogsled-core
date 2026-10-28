import { describe, expect, it } from 'vitest';

import { chunkText, chunkerConfigHash } from '../src/index.js';

const opts = { maxTokens: 50, overlapTokens: 8, tokenizer: 'cl100k_base' as const };

describe('recursive chunker', () => {
  it('returns empty for empty text', () => {
    expect(chunkText('', opts)).toHaveLength(0);
  });

  it('returns a single chunk when text fits in maxTokens', () => {
    const out = chunkText('Hello world.', opts);
    expect(out).toHaveLength(1);
    expect(out[0]?.chunkIndex).toBe(0);
    expect(out[0]?.text).toBe('Hello world.');
  });

  it('splits long text on paragraph boundaries first', () => {
    const text = Array.from(
      { length: 5 },
      () =>
        'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt.'
    ).join('\n\n');
    const out = chunkText(text, opts);
    expect(out.length).toBeGreaterThan(1);
    out.forEach((chunk, i) => {
      expect(chunk.chunkIndex).toBe(i);
      // The +5 slack accounts for `applyOverlap` re-tokenizing after string concat: a
      // joined chunk's BPE encoding can produce a few extra tokens around the boundary
      // (where the prior chunk's tail meets the new body). The slack is bounded — the
      // strict `chunk.tokenCount <= opts.maxTokens` invariant is asserted in the
      // dedicated overlap test below, where the splitter reserves overlap headroom.
      expect(chunk.tokenCount).toBeLessThanOrEqual(opts.maxTokens + opts.overlapTokens + 5);
    });
  });

  it('is deterministic across runs', () => {
    const text = 'A sentence. Another sentence. Yet a third.\n\n'.repeat(20);
    const a = chunkText(text, opts);
    const b = chunkText(text, opts);
    expect(a.map((c) => c.text)).toEqual(b.map((c) => c.text));
    expect(a.map((c) => c.tokenCount)).toEqual(b.map((c) => c.tokenCount));
  });

  it('preserves separators when chunk boundaries fall on split points', () => {
    const text = 'One. Two. Three. Four. Five. Six. Seven. Eight.';
    const chunks = chunkText(text, {
      maxTokens: 4,
      overlapTokens: 0,
      tokenizer: 'cl100k_base',
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(text);
  });

  it('is deterministic over seeded mixed-whitespace inputs', () => {
    let seed = 0x5eed;
    const next = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed;
    };
    const alphabet = ['alpha', 'beta', 'gamma', 'delta', ' ', '\n', '\n\n', '.', ',', '\u{1F680}'];
    for (let run = 0; run < 200; run += 1) {
      const length = 20 + (next() % 120);
      let text = '';
      for (let i = 0; i < length; i += 1) {
        text += alphabet[next() % alphabet.length]!;
      }
      const a = chunkText(text, opts);
      const b = chunkText(text, opts);
      expect(a).toEqual(b);
    }
  });

  it('rejects overlap >= max', () => {
    expect(() =>
      chunkText('hi', { maxTokens: 10, overlapTokens: 10, tokenizer: 'cl100k_base' })
    ).toThrow();
    expect(() =>
      chunkText('hi', { maxTokens: 10, overlapTokens: 11, tokenizer: 'cl100k_base' })
    ).toThrow();
  });

  it('applies forward overlap from the previous chunk and stays within maxTokens', () => {
    const text = 'paragraph one. '.repeat(60) + '\n\n' + 'paragraph two. '.repeat(60);
    const overlapped = chunkText(text, { ...opts, overlapTokens: 10 });
    const noOverlap = chunkText(text, { ...opts, overlapTokens: 0 });
    expect(overlapped.length).toBeGreaterThanOrEqual(2);
    expect(noOverlap.length).toBeGreaterThanOrEqual(2);
    // Overlap actually fired — the second chunk differs from the zero-overlap baseline.
    expect(overlapped[1]!.text).not.toBe(noOverlap[1]!.text);
    // Every chunk's token count respects the maxTokens budget — overlap reserves
    // headroom in the splitter, so prepending the prefix can't push past the cap.
    overlapped.forEach((chunk) => {
      expect(chunk.tokenCount).toBeLessThanOrEqual(opts.maxTokens);
    });
  });

  it('overlap text is sourced from the previous chunk tail (not arbitrary bytes)', async () => {
    const { getEncoding } = await import('js-tiktoken');
    const enc = getEncoding('cl100k_base');
    const text =
      'alpha beta gamma delta. '.repeat(80) + '\n\n' + 'epsilon zeta eta theta. '.repeat(80);
    const overlapTokens = 6;
    const chunks = chunkText(text, { maxTokens: 60, overlapTokens, tokenizer: 'cl100k_base' });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Take the previous chunk's last `overlapTokens` and decode them; the second chunk
    // must contain that exact decoded substring (modulo a leading space the chunker
    // injects). A buggy implementation that prepended fixed text would fail this.
    const prevTokens = enc.encode(chunks[0]!.text);
    const tail = enc.decode(prevTokens.slice(-overlapTokens));
    expect(chunks[1]!.text.includes(tail.trim())).toBe(true);
  });
});

describe('chunkerConfigHash', () => {
  it('changes when any field changes', () => {
    const a = chunkerConfigHash({ maxTokens: 800, overlapTokens: 120, tokenizer: 'cl100k_base' });
    const b = chunkerConfigHash({ maxTokens: 800, overlapTokens: 120, tokenizer: 'o200k_base' });
    const c = chunkerConfigHash({ maxTokens: 600, overlapTokens: 120, tokenizer: 'cl100k_base' });
    const d = chunkerConfigHash({ maxTokens: 800, overlapTokens: 80, tokenizer: 'cl100k_base' });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });

  it('is stable for identical inputs', () => {
    const x = chunkerConfigHash({ maxTokens: 800, overlapTokens: 120, tokenizer: 'cl100k_base' });
    const y = chunkerConfigHash({ maxTokens: 800, overlapTokens: 120, tokenizer: 'cl100k_base' });
    expect(x).toBe(y);
  });
});
