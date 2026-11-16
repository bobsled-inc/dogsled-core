import { deepStrictEqual, throws } from 'node:assert/strict';

import { describe, it } from 'vitest';

import {
  addInternalRuntimeDependencies,
  copyBundledPackageAssets,
  stripBundledManifestDependencies,
  removeInlinedAiDependencies,
  normalizeManifestDependencySpecifiers,
} from '../../scripts/release/stage-package.mjs';
import {
  INLINED_AI_DEPENDENCY_NAMES,
  INTERNAL_PACKAGE_NAMES,
} from '../../scripts/release/package-set.mjs';

describe('release package staging', () => {
  it('does not make consumers reinstall dependencies already inlined into AI output', () => {
    const manifest = {
      name: '@bobsled-inc/ai',
      dependencies: {
        ...Object.fromEntries(INLINED_AI_DEPENDENCY_NAMES.map((name) => [name, '1.0.0'])),
        '@bobsled-inc/connections': '0.20.224',
        '@aws-sdk/credential-providers': '3.1017.0',
        zod: '4.3.6',
      },
    };
    removeInlinedAiDependencies(manifest);
    deepStrictEqual(manifest.dependencies, {
      '@bobsled-inc/connections': '0.20.224',
      '@aws-sdk/credential-providers': '3.1017.0',
      zod: '4.3.6',
    });
    const other = { name: '@bobsled-inc/other', dependencies: { ai: '6.0.168' } };
    removeInlinedAiDependencies(other);
    deepStrictEqual(other.dependencies, { ai: '6.0.168' });
  });

  it('restores reviewed dependency versions after pnpm deploy rewrites them', () => {
    const manifest = {
      dependencies: {
        '@bobsled-inc/loader': 'link:../loader',
        '@google-cloud/storage': '7.19.0(encoding@0.1.13)',
      },
    };
    const sourceManifest = {
      dependencies: {
        '@bobsled-inc/loader': 'workspace:*',
        '@google-cloud/storage': '7.19.0',
      },
    };
    const packages = new Map([['@bobsled-inc/loader', { packageJson: { version: '0.20.224' } }]]);

    normalizeManifestDependencySpecifiers(manifest, sourceManifest, packages, {});

    deepStrictEqual(manifest.dependencies, {
      '@bobsled-inc/loader': '0.20.224',
      '@google-cloud/storage': '7.19.0',
    });
  });

  it('restores the reviewed Snowflake driver floor from the source manifest', async () => {
    const { readFile } = await import('node:fs/promises');
    const sourceManifest = JSON.parse(
      await readFile(new URL('../../packages/loader/package.json', import.meta.url), 'utf8')
    );
    const manifest = {
      peerDependencies: {
        'snowflake-sdk': 'link:../snowflake-sdk',
      },
    };

    normalizeManifestDependencySpecifiers(manifest, sourceManifest, new Map(), {});

    deepStrictEqual(manifest.peerDependencies, {
      'snowflake-sdk': '>=3.4.0',
    });
  });

  it('keeps external dependencies and driver peers out of bundled internal manifests', () => {
    const staged = {
      name: '@bobsled-inc/bobsled-core',
      dependencies: { chalk: '5.6.2', zod: '4.3.6' },
      optionalDependencies: { pg: '>=8.4.0' },
    };
    const loader = {
      name: '@bobsled-inc/loader',
      dependencies: { '@bobsled-inc/protocol': '0.20.224', chalk: '5.6.2', zod: '4.3.6' },
      optionalDependencies: { pg: '>=8.4.0' },
      peerDependencies: { pg: '>=8.4.0', mysql2: '>=3.22.0' },
      peerDependenciesMeta: { pg: { optional: true }, mysql2: { optional: true } },
    };
    const connections = {
      name: '@bobsled-inc/connections',
      peerDependencies: { mysql2: '>=3.22.0' },
    };

    stripBundledManifestDependencies(staged, [loader, connections]);

    deepStrictEqual(loader, {
      name: '@bobsled-inc/loader',
      dependencies: { '@bobsled-inc/protocol': '0.20.224', zod: '4.3.6' },
    });
    deepStrictEqual(connections, { name: '@bobsled-inc/connections', dependencies: {} });
    deepStrictEqual(staged, {
      name: '@bobsled-inc/bobsled-core',
      dependencies: { chalk: '5.6.2', zod: '4.3.6' },
      optionalDependencies: { pg: '>=8.4.0' },
    });
  });

  it('rejects a bundled dependency that the top-level manifest does not declare', () => {
    const staged = { name: '@bobsled-inc/bobsled-core', dependencies: { zod: '4.3.6' } };
    const loader = {
      name: '@bobsled-inc/loader',
      dependencies: { '@bobsled-inc/protocol': '0.20.224', chalk: '5.6.2', zod: '4.3.6' },
    };
    throws(
      () => stripBundledManifestDependencies(staged, [loader]),
      /@bobsled-inc\/loader needs chalk, but @bobsled-inc\/bobsled-core does not declare it/
    );
  });

  it('rejects an installed driver range that differs from the bundled peer range', () => {
    const staged = { name: '@bobsled-inc/bobsled-core', optionalDependencies: { pg: '8.20.0' } };
    const loader = {
      name: '@bobsled-inc/loader',
      peerDependencies: { pg: '>=8.4.0' },
      peerDependenciesMeta: { pg: { optional: true } },
    };
    throws(
      () => stripBundledManifestDependencies(staged, [loader]),
      /accepts pg >=8\.4\.0, but @bobsled-inc\/bobsled-core installs pg 8\.20\.0/
    );
  });

  it('ships source-checkout assets inside the bundled package that reads them', async () => {
    const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } =
      await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const outputDir = mkdtempSync(path.join(os.tmpdir(), 'dogsled-stage-assets-'));
    try {
      const entityGraph = path.join(outputDir, 'node_modules/@bobsled-inc/entity-graph');
      mkdirSync(entityGraph, { recursive: true });
      writeFileSync(
        path.join(entityGraph, 'package.json'),
        JSON.stringify({ name: '@bobsled-inc/entity-graph', files: ['dist/'] })
      );
      copyBundledPackageAssets(outputDir);
      deepStrictEqual(
        JSON.parse(readFileSync(path.join(entityGraph, 'package.json'), 'utf8')).files,
        ['dist/', 'fixtures/']
      );
      deepStrictEqual(
        existsSync(path.join(entityGraph, 'fixtures/b2b-company-master/company_basic.yml')),
        true
      );
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
