import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { autoEmitDocumentSpec } from '../../src/api/auto-spec.js';

describe('autoEmitDocumentSpec', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'auto-spec-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the spec on first call when the target does not exist', () => {
    const result = autoEmitDocumentSpec({
      cwd: dir,
      mdmDir: 'entity-graph',
      resourceName: 'support',
    });
    expect(result.written).toBe(true);
    if (result.written) expect(result.reason).toBe('created');
    const target = join(dir, 'entity-graph', 'document', 'support', 'spec.yml');
    expect(existsSync(target)).toBe(true);
    const content = readFileSync(target, 'utf8');
    expect(content).toContain('name: support_document_resolution');
    expect(content).toContain('survivorship');
    expect(content).toContain('extracted_at');
  });

  it('returns already_exists when a user-authored spec is present', () => {
    const target = join(dir, 'entity-graph', 'document', 'support', 'spec.yml');
    mkdirSync(join(dir, 'entity-graph', 'document', 'support'), { recursive: true });
    writeFileSync(target, '# user override', 'utf8');
    const result = autoEmitDocumentSpec({
      cwd: dir,
      mdmDir: 'entity-graph',
      resourceName: 'support',
    });
    expect(result.written).toBe(false);
    if (!result.written) expect(result.reason).toBe('already_exists');
    expect(readFileSync(target, 'utf8')).toBe('# user override');
  });

  it('honors a custom recency column when provided', () => {
    autoEmitDocumentSpec({
      cwd: dir,
      mdmDir: 'entity-graph',
      resourceName: 'docs',
      recencyColumn: 'updated_at',
    });
    const content = readFileSync(join(dir, 'entity-graph', 'document', 'docs', 'spec.yml'), 'utf8');
    expect(content).toContain('on: updated_at');
  });

  it('rejects unsafe resourceName via the underlying template guard', () => {
    expect(() =>
      autoEmitDocumentSpec({
        cwd: dir,
        mdmDir: 'entity-graph',
        resourceName: 'has space',
      })
    ).toThrow(/Invalid resourceName/);
  });

  it('throws when mdmDir is missing or invalid', () => {
    expect(() =>
      autoEmitDocumentSpec({
        cwd: dir,
        // @ts-expect-error testing runtime guard
        mdmDir: undefined,
        resourceName: 'support',
      })
    ).toThrow(/mdmDir is required/);
  });

  it('rejects mdmDir values that escape cwd (path traversal)', () => {
    // The runtime guard refuses
    // mdmDir values that resolve outside the project root, even before
    // any FS write happens.
    expect(() =>
      autoEmitDocumentSpec({
        cwd: dir,
        mdmDir: '../../outside',
        resourceName: 'support',
      })
    ).toThrow(/escapes cwd|mdmDir/i);
    expect(() =>
      autoEmitDocumentSpec({
        cwd: dir,
        mdmDir: '/etc',
        resourceName: 'support',
      })
    ).toThrow(/escapes cwd|mdmDir/i);
  });
});
