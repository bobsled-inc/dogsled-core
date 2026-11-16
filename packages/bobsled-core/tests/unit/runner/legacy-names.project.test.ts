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

// Compatibility test: the rename never rewrites this file, so both spellings
// stay literal. Avoid importing names that the rename changes.
type Spelling = 'dogsled' | 'bobsled';

function files(spelling: Spelling) {
  const ref = `${spelling}_connection_ref`;
  const kind = `${spelling}_source_kind`;
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
          type: `${spelling}_managed`,
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

function writeProject(spelling: Spelling): void {
  for (const [name, document] of Object.entries(files(spelling))) {
    const file = path.join(projectRoot, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, YAML.stringify(document));
  }
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-reconciler-'));
});
afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('reconciler-style Blueprint compatibility', () => {
  async function compile(spelling: Spelling) {
    writeProject(spelling);
    const index = scanProject(projectRoot);
    expect(index.issues).toEqual([]);
    expect(index.deprecations ?? []).toEqual([]);
    const validation = await validateProjectPipelines({ projectRoot, index });
    expect(validation.status).toBe('valid');
    expect(validation.issues).toEqual([]);
    expect(validation.warnings.filter((warning) => /LEGACY_BLUEPRINT_KEY/.test(warning))).toEqual(
      []
    );
    return {
      documents: index.entries.map(({ document }) => document),
      resolved: await resolveProjectPipelines({ projectRoot, index }),
      manifest: await generateProjectManifest({ projectRoot, index }),
    };
  }

  it('indexes, validates, resolves and compiles Dogsled and Bobsled spellings identically, with no warning', async () => {
    const dogsled = await compile('dogsled');
    const bobsled = await compile('bobsled');
    expect(bobsled.documents).toEqual(dogsled.documents);
    expect(bobsled.resolved.config).toEqual(dogsled.resolved.config);
    expect(bobsled.resolved.extractPipelines).toEqual(dogsled.resolved.extractPipelines);
    expect(bobsled.manifest).toEqual(dogsled.manifest);
  });

  it.each(['integrations/api.yml', 'config/pipelines.yml'] as const)(
    'rejects conflicting regenerated keys in %s',
    async (name) => {
      writeProject(true);
      const document = files('bobsled')[name];
      if (name === 'integrations/api.yml') {
        fs.writeFileSync(
          path.join(projectRoot, name),
          YAML.stringify({ ...document, dogsled_connection_ref: 'private-new' })
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
                dogsled_connection_ref: 'private-new',
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
