import {
  BLUEPRINT_CONNECTION_REF_KEY,
  BLUEPRINT_SOURCE_KIND_KEY,
  MANAGED_DESTINATION_TYPE,
} from '@bobsled-inc/protocol';
import { describe, expect, it } from 'vitest';

import {
  assertValidProjectIndex,
  classifyProjectFile,
  indexProjectFiles,
} from '../../src/index.js';

// Compatibility test: the rename never rewrites this file, so both spellings stay literal.
const SPELLINGS = [
  ['dogsled_connection_ref', 'dogsled_source_kind', 'dogsled_managed'],
  ['bobsled_connection_ref', 'bobsled_source_kind', 'bobsled_managed'],
] as const;

describe.each(SPELLINGS)('Blueprint index reads %s, %s and %s', (ref, kind, managed) => {
  const bindings = `${ref}: api-binding\n${kind}: bobsled_api\n`;

  it.each([
    ['integrations/api.yml', '', 'integration'],
    ['sources/api.yml', '', 'source'],
    ['api.yml', 'type: source\n', 'integration'],
    ['api.yml', 'type: integration\n', 'integration'],
    ['api.yml', 'type: source\nspec_version: "2"\n', 'integration'],
  ])(
    'normalizes %s without warnings or changing the authored content',
    (path, prefix, entryKind) => {
      const content = prefix + bindings;
      const classification = classifyProjectFile({ path, content });
      expect(classification).toMatchObject({
        status: 'recognized',
        entry: {
          kind: entryKind,
          content,
          document: {
            [BLUEPRINT_CONNECTION_REF_KEY]: 'api-binding',
            [BLUEPRINT_SOURCE_KIND_KEY]: 'bobsled_api',
          },
        },
      });
      expect(classification.deprecations ?? []).toEqual([]);
    }
  );

  it('canonicalizes destination entries while preserving nested data and other document kinds', () => {
    const pipeline = `type: pipeline_config\ndestinations:\n  warehouse:\n    type: ${managed}\n    ${ref}: warehouse-prod\npipelines:\n  api:\n    inputs:\n      ${ref}: user-data\n`;
    const index = indexProjectFiles([
      { path: 'pipelines.yml', content: pipeline },
      { path: 'resource.yml', content: `type: resource\n${ref}: user-data\n` },
    ]);
    expect(index.issues).toEqual([]);
    expect(index.entries[0]?.content).toBe(pipeline);
    expect(index.entries[0]?.document).toMatchObject({
      destinations: {
        warehouse: {
          type: MANAGED_DESTINATION_TYPE,
          [BLUEPRINT_CONNECTION_REF_KEY]: 'warehouse-prod',
        },
      },
      pipelines: { api: { inputs: { [ref]: 'user-data' } } },
    });
    expect(index.entries[1]?.document).toHaveProperty(ref, 'user-data');
    expect(index).not.toHaveProperty('deprecations');
  });

  it('accepts equal duplicates and rejects differing duplicates as blocking issues', () => {
    const [other] = SPELLINGS.find((group) => group[0] !== ref)!;
    const equal = indexProjectFiles([
      { path: 'api.yml', content: `type: integration\n${bindings}${other}: api-binding\n` },
    ]);
    expect(equal.issues).toEqual([]);
    expect(equal).not.toHaveProperty('deprecations');
    const conflict = indexProjectFiles([
      { path: 'api.yml', content: `type: integration\n${bindings}${other}: private-new\n` },
    ]);
    expect(conflict.entries).toEqual([]);
    expect(conflict.issues).toMatchObject([
      { code: 'LEGACY_KEY_CONFLICT', path: 'api.yml', kind: 'integration' },
    ]);
    expect(conflict.issues[0]?.message).not.toContain('private-new');
    expect(() => assertValidProjectIndex(conflict)).toThrow('LEGACY_KEY_CONFLICT');
  });
});
