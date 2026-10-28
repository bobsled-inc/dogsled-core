import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));

describe('catalog-only probe import boundary', () => {
  it('does not load native execution dependencies', () => {
    const script = `
      const nativeLoads = [];
      process.dlopen = (_module, filename) => {
        nativeLoads.push(filename);
        throw new Error('native dependency loaded');
      };
      const catalog = await import('@bobsled-inc/dogsled/integrations/catalog');
      if (typeof catalog.probeApiResource !== 'function') throw new Error('probe export missing');
      if (typeof catalog.buildCatalogManifest !== 'function') throw new Error('catalog export missing');
      if (nativeLoads.length > 0) throw new Error('native dependency loaded');
    `;

    expect(() =>
      execFileSync(
        process.execPath,
        ['--import', 'tsx/esm', '--input-type=module', '--eval', script],
        { cwd: repositoryRoot, stdio: 'pipe' }
      )
    ).not.toThrow();
  });
});
