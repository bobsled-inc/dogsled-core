import { describe, expect, it } from 'vitest';

import { CommandError } from '../../src/errors.js';
import { parseSelector, resolveSelection, type SelectableNode } from '../../src/selection.js';

/**
 * Graph used by most tests:
 *
 *   a → b → c
 *    \
 *     → d
 *
 * (`a` is upstream of `b` and `d`; `b` is upstream of `c`.) The asymmetry (a
 * branch that `c` is NOT on) is deliberate — it makes `+X` (ancestors) vs `X+`
 * (descendants) non-invertible so a flipped-direction bug can't pass.
 */
const NODES: SelectableNode[] = [
  { name: 'a', refs: [], tags: ['staging'] },
  { name: 'b', refs: ['a'], tags: ['marts'] },
  { name: 'c', refs: ['b'], tags: ['marts', 'finance'] },
  { name: 'd', refs: ['a'], tags: ['finance'] },
];

describe('parseSelector', () => {
  it('parses a bare name as exact', () => {
    expect(parseSelector('orders')).toEqual({
      core: { kind: 'name', value: 'orders' },
      ancestors: false,
      descendants: false,
    });
  });

  it('parses +X / X+ / +X+ operators', () => {
    expect(parseSelector('+orders')).toMatchObject({ ancestors: true, descendants: false });
    expect(parseSelector('orders+')).toMatchObject({ ancestors: false, descendants: true });
    expect(parseSelector('+orders+')).toMatchObject({ ancestors: true, descendants: true });
  });

  it('parses a tag selector with operators', () => {
    expect(parseSelector('tag:finance')).toEqual({
      core: { kind: 'tag', value: 'finance' },
      ancestors: false,
      descendants: false,
    });
    expect(parseSelector('+tag:finance+')).toEqual({
      core: { kind: 'tag', value: 'finance' },
      ancestors: true,
      descendants: true,
    });
  });

  it('rejects intersection (comma) syntax explicitly', () => {
    expect(() => parseSelector('tag:nightly,+orders')).toThrow(/intersection/i);
  });

  it('rejects malformed tokens', () => {
    expect(() => parseSelector('+')).toThrow(CommandError);
    expect(() => parseSelector('++orders')).toThrow(CommandError);
    expect(() => parseSelector('tag:')).toThrow(/empty tag/i);
    expect(() => parseSelector('   ')).toThrow(/empty token/i);
  });
});

describe('resolveSelection — exact (bare) default', () => {
  it('selects exactly the named node (no upstream closure)', () => {
    expect(resolveSelection(NODES, ['c'])).toEqual(['c']);
    expect(resolveSelection(NODES, ['b'])).toEqual(['b']);
  });

  it('unions multiple bare names, de-duplicated, in topological order', () => {
    expect(resolveSelection(NODES, ['c', 'b'])).toEqual(['b', 'c']);
    expect(resolveSelection(NODES, ['c', 'c'])).toEqual(['c']);
  });

  it('empty selection means all nodes (topological order)', () => {
    expect(resolveSelection(NODES, [])).toEqual(['a', 'b', 'c', 'd']);
    // A stray empty-string arg is dropped, not treated as a node.
    expect(resolveSelection(NODES, [''])).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('resolveSelection — graph operators (asymmetric graph)', () => {
  it('+X selects X and all ancestors only', () => {
    expect(resolveSelection(NODES, ['+c'])).toEqual(['a', 'b', 'c']);
    expect(resolveSelection(NODES, ['+a'])).toEqual(['a']); // no ancestors
  });

  it('X+ selects X and all descendants only', () => {
    expect(resolveSelection(NODES, ['c+'])).toEqual(['c']); // leaf, no descendants
    expect(resolveSelection(NODES, ['a+'])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('+X+ selects ancestors and descendants', () => {
    expect(resolveSelection(NODES, ['+b+'])).toEqual(['a', 'b', 'c']);
  });

  it('handles a diamond, de-duplicating shared ancestors/descendants', () => {
    const diamond: SelectableNode[] = [
      { name: 'a', refs: [] },
      { name: 'b', refs: ['a'] },
      { name: 'c', refs: ['a'] },
      { name: 'dd', refs: ['b', 'c'] },
    ];
    expect(resolveSelection(diamond, ['+dd'])).toEqual(['a', 'b', 'c', 'dd']);
    expect(resolveSelection(diamond, ['a+'])).toEqual(['a', 'b', 'c', 'dd']);
  });
});

describe('resolveSelection — tags', () => {
  it('selects all nodes carrying a tag (case-sensitive)', () => {
    expect(resolveSelection(NODES, ['tag:finance'])).toEqual(['c', 'd']);
    expect(resolveSelection(NODES, ['tag:marts'])).toEqual(['b', 'c']);
  });

  it('does not match a tag with the wrong case (dbt parity)', () => {
    expect(resolveSelection(NODES, ['tag:Finance'])).toEqual([]);
  });

  it('composes tag selectors with graph operators', () => {
    // tag:finance = {c, d}; +tag:finance adds their ancestors {a, b}.
    expect(resolveSelection(NODES, ['+tag:finance'])).toEqual(['a', 'b', 'c', 'd']);
    // tag:staging = {a}; tag:staging+ adds descendants {b, c, d}.
    expect(resolveSelection(NODES, ['tag:staging+'])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns an empty contribution for an unknown tag (no error)', () => {
    expect(resolveSelection(NODES, ['tag:nonexistent'])).toEqual([]);
    // Combined with a real selector, the unknown tag just adds nothing.
    expect(resolveSelection(NODES, ['tag:nonexistent', 'b'])).toEqual(['b']);
  });
});

describe('resolveSelection — matching rules', () => {
  it('matches names case-insensitively', () => {
    expect(resolveSelection(NODES, ['C'])).toEqual(['c']);
    expect(resolveSelection(NODES, ['+B'])).toEqual(['a', 'b']);
  });

  it('preserves the original authored case in the result', () => {
    const mixed: SelectableNode[] = [
      { name: 'StgOrders', refs: [] },
      { name: 'FctOrders', refs: ['stgorders'] },
    ];
    expect(resolveSelection(mixed, ['+fctorders'])).toEqual(['StgOrders', 'FctOrders']);
  });

  it('treats a bare token as a name only, never a tag (no collision)', () => {
    const collide: SelectableNode[] = [
      { name: 'finance', refs: [], tags: ['ignored'] },
      { name: 'other', refs: [], tags: ['finance'] },
    ];
    // Bare `finance` is the model named finance, not the tag.
    expect(resolveSelection(collide, ['finance'])).toEqual(['finance']);
    // `tag:finance` is the tag, which is on `other`.
    expect(resolveSelection(collide, ['tag:finance'])).toEqual(['other']);
  });

  it('throws on an unknown name with the historical substring + available list', () => {
    try {
      resolveSelection(NODES, ['nope']);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CommandError);
      expect((err as CommandError).message).toContain('No models found matching: nope');
      expect((err as CommandError).message).toContain('a, b, c, d');
    }
  });

  it('ignores refs that point outside the node set', () => {
    // Input is topologically ordered (parent before child), as callers
    // guarantee; the result preserves that order.
    const partial: SelectableNode[] = [
      { name: 'present', refs: [] },
      { name: 'child', refs: ['missing_parent', 'present'] },
    ];
    // `missing_parent` is not a node, so +child only pulls `present`.
    expect(resolveSelection(partial, ['+child'])).toEqual(['present', 'child']);
  });
});
