import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BUILT_IN_SOURCE_FILES,
  BUILT_IN_SOURCES_SHA256,
} from '../src/builtin-sources/generated-data.js';

let tempRoot: string;
const originalTmpdir = process.env['TMPDIR'];

async function freshModules() {
  vi.resetModules();
  const loader = await import('../src/loader.js');
  const index = await import('../src/index.js');
  return { loader, index };
}

function sharedCopy(): string {
  const owner = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
  return join(tempRoot, `bobsled-integrations-${owner}-${BUILT_IN_SOURCES_SHA256.slice(0, 16)}`);
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'integrations-materialize-test-'));
  process.env['TMPDIR'] = tempRoot;
});

afterEach(() => {
  if (originalTmpdir === undefined) delete process.env['TMPDIR'];
  else process.env['TMPDIR'] = originalTmpdir;
  chmodSync(tempRoot, 0o700);
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('built-in sources without a filesystem copy', () => {
  it('serves lookups, queries and actions without writing temporary files', async () => {
    const { index } = await freshModules();
    expect(index.getSource('bobsled_api').name).toBe('bobsled_api');
    expect(index.listQueryResources().length).toBeGreaterThan(0);
    const actions = index.listActions();
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(action.filePath).toMatch(/^sources\/[^/]+\/actions\/[^/]+\.yml$/);
      expect(index.getAction(action.integration ?? '', action.name).qualifiedName).toBe(
        action.qualifiedName
      );
    }
    expect(index.loadBuiltInActions().map((action) => action.qualifiedName)).toEqual(
      actions.map((action) => action.qualifiedName)
    );
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it('returns the raw text of a top-level built-in file', async () => {
    const { loader } = await freshModules();
    expect(loader.readBuiltInSourceFile('stripe', 'source.yml')).toBe(
      BUILT_IN_SOURCE_FILES['stripe/source.yml']
    );
    expect(loader.readBuiltInSourceFile('stripe', 'integration.yml')).toBeUndefined();
    expect(loader.readBuiltInSourceFile('../stripe', 'source.yml')).toBeUndefined();
  });
});

describe('built-in sources copy for path callers', () => {
  it('writes one private copy per user and content version and reuses it', async () => {
    const first = (await freshModules()).loader.getSourcesDir();
    expect(first).toBe(join(sharedCopy(), 'sources'));
    expect(statSync(sharedCopy()).mode & 0o077).toBe(0);
    for (const [key, content] of Object.entries(BUILT_IN_SOURCE_FILES)) {
      expect(readFileSync(join(first, ...key.split('/')), 'utf-8')).toBe(content);
    }

    const second = (await freshModules()).loader.getIntegrationsDir();
    expect(second).toBe(first);
    expect(readdirSync(tempRoot)).toEqual([sharedCopy().slice(tempRoot.length + 1)]);
  });

  it('rebuilds a copy whose files were removed or changed', async () => {
    const first = (await freshModules()).loader.getSourcesDir();
    rmSync(join(first, 'stripe', 'source.yml'));

    const rebuilt = (await freshModules()).loader.getSourcesDir();
    expect(rebuilt).toBe(first);
    expect(readFileSync(join(rebuilt, 'stripe', 'source.yml'), 'utf-8')).toBe(
      BUILT_IN_SOURCE_FILES['stripe/source.yml']
    );
    expect(readdirSync(tempRoot)).toHaveLength(1);
  });

  it.skipIf(typeof process.getuid !== 'function')(
    'does not trust a shared copy that other users can change',
    async () => {
      const first = (await freshModules()).loader.getSourcesDir();
      chmodSync(sharedCopy(), 0o777);

      const fallback = (await freshModules()).loader.getSourcesDir();
      expect(fallback).not.toBe(first);
      expect(fallback.startsWith(tempRoot)).toBe(true);
      expect(statSync(join(fallback, '..')).mode & 0o077).toBe(0);
      expect(readFileSync(join(fallback, 'stripe', 'source.yml'), 'utf-8')).toBe(
        BUILT_IN_SOURCE_FILES['stripe/source.yml']
      );
      chmodSync(sharedCopy(), 0o700);
    }
  );
});
