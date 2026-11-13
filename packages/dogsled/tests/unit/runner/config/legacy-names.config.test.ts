import { BLUEPRINT_CONNECTION_REF_KEY, MANAGED_DESTINATION_TYPE } from '@bobsled-inc/protocol';
import { describe, expect, it } from 'vitest';

import { normalizePipelineBlueprint } from '../../../../src/runner/config/legacy-blueprint.js';
import { DestinationSchema, NamedDestinationSchema } from '../../../../src/runner/config/schema.js';

// Compatibility test: the rename never rewrites this file, so both spellings
// stay literal. Avoid importing names that the rename changes.
const REFS = ['dogsled_connection_ref', 'bobsled_connection_ref'];
const MANAGED = ['dogsled_managed', 'bobsled_managed'];

describe('destination spellings in pipeline config', () => {
  it.each(
    (['DestinationSchema', 'NamedDestinationSchema'] as const).flatMap((label) =>
      MANAGED.flatMap((type) => REFS.map((ref) => [label, type, ref] as const))
    )
  )('normalizes managed destinations in %s (%s, %s)', (label, type, ref) => {
    const input = { type, [ref]: 'warehouse-prod' };
    const result =
      label === 'DestinationSchema'
        ? DestinationSchema.parse(input)
        : NamedDestinationSchema.parse({ name: 'warehouse', ...input });
    expect(result).toMatchObject({
      type: MANAGED_DESTINATION_TYPE,
      [BLUEPRINT_CONNECTION_REF_KEY]: 'warehouse-prod',
    });
    for (const other of REFS.filter((key) => key !== BLUEPRINT_CONNECTION_REF_KEY))
      expect(result).not.toHaveProperty(other);
  });

  it.each(REFS)('strips %s on concrete destinations', (ref) => {
    expect(DestinationSchema.parse({ type: 'duckdb', db_path: ':memory:', [ref]: 'prod' })).toEqual(
      {
        type: 'duckdb',
        db_path: ':memory:',
      }
    );
  });

  it('drops equal duplicate refs and rejects different duplicate refs before stripping', () => {
    expect(
      DestinationSchema.parse({
        type: MANAGED[1],
        [REFS[0]!]: 'warehouse-prod',
        [REFS[1]!]: 'warehouse-prod',
      })
    ).toEqual({ type: MANAGED_DESTINATION_TYPE, [BLUEPRINT_CONNECTION_REF_KEY]: 'warehouse-prod' });
    const result = DestinationSchema.safeParse({
      type: 'duckdb',
      db_path: ':memory:',
      [REFS[1]!]: 'private-old',
      [REFS[0]!]: 'private-new',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/^LEGACY_KEY_CONFLICT: /);
      expect(result.error.message).not.toContain('private-old');
      expect(result.error.message).not.toContain('private-new');
    }
  });

  it('rejects conflicting destination refs with a code and file path', () => {
    let failure: unknown;
    try {
      normalizePipelineBlueprint(
        {
          destinations: {
            managed: { type: MANAGED[1], [REFS[1]!]: 'private-old', [REFS[0]!]: 'private-new' },
          },
          pipelines: {},
        },
        '/project/config.yml'
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'LEGACY_KEY_CONFLICT', exitCode: 2 });
    expect((failure as Error).message).toMatch(/^LEGACY_KEY_CONFLICT: \/project\/config\.yml: /);
    expect((failure as Error).message).not.toContain('private-');
  });
});
