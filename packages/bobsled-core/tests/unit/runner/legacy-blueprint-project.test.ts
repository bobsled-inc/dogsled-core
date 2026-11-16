import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { scanProject } from '@bobsled-inc/project-index';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';

import {
  generateProjectManifest,
  resolveProjectPipelines,
  validateProjectPipelines,
} from '../../../src/manifest.js';

let projectRoot: string;

function files(legacy: boolean) {
  const ref = legacy ? 'bobsled_connection_ref' : 'bobsled_connection_ref';
  const kind = legacy ? 'bobsled_source_kind' : 'bobsled_source_kind';
  return {
    'integrations/api.yml': {
      spec_version: '2',
      type: 'integration',
      name: 'bobsled_api',
      [ref]: 'api-binding',
      [kind]: 'bobsled_api',
      transports: [
        {
          id: 'default',
          type: 'http',
          base_url: 'https://api.example.com',
          auth: { type: 'none' },
        },
      ],
    },
    'config/pipelines.yml': {
      type: 'pipeline_config',
      destinations: {
        warehouse: {
          type: legacy ? 'bobsled_managed' : 'bobsled_managed',
          [ref]: 'warehouse-prod',
        },
      },
      pipelines: {
        api_sync: {
          source: 'bobsled_api',
          destination: 'warehouse',
          resources: ['shares'],
          schedule: 'manual',
          runner: 'managed',
        },
      },
    },
  };
}

function writeProject(legacy: boolean): void {
  for (const [name, document] of Object.entries(files(legacy))) {
    const file = path.join(projectRoot, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, YAML.stringify(document));
  }
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bobsled-reconciler-'));
});
afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('reconciler-style Blueprint compatibility', () => {
  it('indexes, validates, resolves, and compiles old and canonical projects identically', async () => {
    writeProject(true);
    const legacyIndex = scanProject(projectRoot);
    expect(legacyIndex.issues).toEqual([]);
    expect(legacyIndex.deprecations).toHaveLength(4);
    const legacyValidation = await validateProjectPipelines({ projectRoot, index: legacyIndex });
    expect(legacyValidation.status).toBe('valid');
    expect(legacyValidation.issues).toEqual([]);
    expect(
      legacyValidation.warnings.filter((warning) =>
        warning.includes('BOBSLED_CORE_LEGACY_BLUEPRINT_KEY')
      )
    ).toHaveLength(4);
    const legacyResolved = await resolveProjectPipelines({ projectRoot, index: legacyIndex });
    const legacyManifest = await generateProjectManifest({
      projectRoot,
      index: legacyIndex,
      bobsledVersion: 'test-version',
    });

    writeProject(false);
    const canonicalIndex = scanProject(projectRoot);
    expect(canonicalIndex.issues).toEqual([]);
    expect(canonicalIndex.deprecations ?? []).toEqual([]);
    expect(legacyIndex.entries.map(({ document }) => document)).toEqual(
      canonicalIndex.entries.map(({ document }) => document)
    );
    const canonicalValidation = await validateProjectPipelines({
      projectRoot,
      index: canonicalIndex,
    });
    expect(canonicalValidation.status).toBe('valid');
    expect(
      canonicalValidation.warnings.filter((warning) =>
        warning.includes('BOBSLED_CORE_LEGACY_BLUEPRINT_KEY')
      )
    ).toEqual([]);
    const canonicalResolved = await resolveProjectPipelines({ projectRoot, index: canonicalIndex });
    expect(legacyResolved.config).toEqual(canonicalResolved.config);
    expect(legacyResolved.extractPipelines).toEqual(canonicalResolved.extractPipelines);
    const canonicalManifest = await generateProjectManifest({
      projectRoot,
      index: canonicalIndex,
      bobsledVersion: 'test-version',
    });
    expect(legacyManifest).toEqual(canonicalManifest);
  });

  it.each(['integrations/api.yml', 'config/pipelines.yml'] as const)(
    'rejects conflicting regenerated keys in %s',
    async (name) => {
      writeProject(true);
      const document = files(true)[name];
      if (name === 'integrations/api.yml') {
        fs.writeFileSync(
          path.join(projectRoot, name),
          YAML.stringify({ ...document, bobsled_connection_ref: 'private-new' })
        );
      } else {
        fs.writeFileSync(
          path.join(projectRoot, name),
          YAML.stringify({
            ...document,
            destinations: {
              warehouse: {
                type: 'bobsled_managed',
                bobsled_connection_ref: 'private-old',
                bobsled_connection_ref: 'private-new',
              },
            },
          })
        );
      }
      const index = scanProject(projectRoot);
      expect(index.issues).toMatchObject([{ code: 'LEGACY_KEY_CONFLICT', path: name }]);
      const validation = await validateProjectPipelines({ projectRoot, index });
      expect(validation.status).toBe('invalid');
      expect(validation.issues[0]?.message).toContain('LEGACY_KEY_CONFLICT');
      expect(validation.issues[0]?.filePath).toBe(name);
      expect(JSON.stringify(validation)).not.toContain('private-new');
      await expect(generateProjectManifest({ projectRoot, index })).rejects.toThrow(
        'LEGACY_KEY_CONFLICT'
      );
    }
  );
});
