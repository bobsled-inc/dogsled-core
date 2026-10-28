/**
 * Unit tests for the transclusion resolver.
 *
 * Verifies the two marker forms (`{{include:}}` and
 * `{{include-section:}}`) resolve correctly against on-disk files,
 * that circular includes are detected, and that the section extractor
 * picks the right heading slice.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  extractSection,
  parseSkill,
  resolveTransclusions,
  slugifyHeading,
} from '../scripts/build-manifest.js';

describe('parseSkill', () => {
  it('splits front-matter from body', () => {
    const raw = '---\nname: foo\ndescription: bar\n---\n# Title\n\nbody';
    const parsed = parseSkill(raw);
    expect(parsed.frontMatter.name).toBe('foo');
    expect(parsed.frontMatter.description).toBe('bar');
    expect(parsed.body.startsWith('# Title')).toBe(true);
  });

  it('rejects files without front-matter', () => {
    expect(() => parseSkill('# Just markdown')).toThrow(/front-matter/);
  });

  it('parses triggers array', () => {
    const raw = '---\nname: foo\ntriggers:\n  - one\n  - two\nexposed: true\n---\nbody';
    const parsed = parseSkill(raw);
    expect(parsed.frontMatter.triggers).toEqual(['one', 'two']);
    expect(parsed.frontMatter.exposed).toBe(true);
  });
});

describe('slugifyHeading', () => {
  it('lowercases and hyphenates', () => {
    expect(slugifyHeading('Type Catalog')).toBe('type-catalog');
  });
  it('strips backticks and punctuation', () => {
    expect(slugifyHeading('`on_schema_change`')).toBe('on_schema_change');
    expect(slugifyHeading('Errors and exit codes')).toBe('errors-and-exit-codes');
  });
});

describe('extractSection', () => {
  const md = [
    '# Top',
    'top body',
    '## First',
    'first body',
    '### First sub',
    'first sub body',
    '## Second',
    'second body',
  ].join('\n');

  it('extracts a section up to the next same-or-shallower heading', () => {
    expect(extractSection(md, 'First')).toBe(
      ['## First', 'first body', '### First sub', 'first sub body'].join('\n')
    );
  });

  it('extracts the final section to EOF', () => {
    expect(extractSection(md, 'Second')).toBe(['## Second', 'second body'].join('\n'));
  });

  it('throws when the heading is missing', () => {
    expect(() => extractSection(md, 'Missing')).toThrow(/not found/);
  });
});

describe('resolveTransclusions', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'skills-test-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('resolves a simple {{include:}} marker', () => {
    mkdirSync(join(workspace, 'docs'), { recursive: true });
    writeFileSync(join(workspace, 'docs', 'snippet.md'), 'hello world\n');
    const body = 'before\n{{include: docs/snippet.md}}\nafter';
    const out = resolveTransclusions(body, workspace);
    expect(out).toBe('before\nhello world\nafter');
  });

  it('resolves an {{include-section:}} marker', () => {
    mkdirSync(join(workspace, 'docs'), { recursive: true });
    writeFileSync(
      join(workspace, 'docs', 'ref.md'),
      ['# Top', '## One', 'alpha', '## Two', 'beta'].join('\n')
    );
    const body = '{{include-section: docs/ref.md#One}}';
    const out = resolveTransclusions(body, workspace);
    expect(out).toBe('## One\nalpha');
  });

  it('throws on circular includes that exceed depth', () => {
    mkdirSync(join(workspace, 'docs'), { recursive: true });
    writeFileSync(join(workspace, 'docs', 'a.md'), '{{include: docs/b.md}}');
    writeFileSync(join(workspace, 'docs', 'b.md'), '{{include: docs/a.md}}');
    expect(() => resolveTransclusions('{{include: docs/a.md}}', workspace)).toThrow(/depth limit/);
  });

  it('leaves bodies without markers untouched', () => {
    expect(resolveTransclusions('plain content\n', workspace)).toBe('plain content\n');
  });
});
