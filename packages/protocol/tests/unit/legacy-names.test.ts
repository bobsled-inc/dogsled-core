import { describe, expect, it } from 'vitest';

import {
  BLUEPRINT_CONNECTION_REF_KEY,
  BLUEPRINT_EXTENSION_KEY_PREFIXES,
  BLUEPRINT_KEY_SPELLINGS,
  BLUEPRINT_SOURCE_KIND_KEY,
  LEGACY_BLUEPRINT_KEY_ALIASES,
  LEGACY_DESTINATION_TYPE_ALIASES,
  LegacyBlueprintKeyConflictError,
  MANAGED_DESTINATION_TYPE,
  MANAGED_DESTINATION_TYPE_SPELLINGS,
  REJECTED_LEGACY_DESTINATION_TYPES,
  isManagedDestinationType,
  normalizeLegacyBlueprintKeys,
} from '../../src/index.js';

// This file is a compatibility test: the rename never rewrites it, so the old
// and new spellings below stay literal while the current spelling comes from
// the code under test.
const CONNECTION_REF_SPELLINGS = ['dogsled_connection_ref', 'bobsled_connection_ref'];
const SOURCE_KIND_SPELLINGS = ['dogsled_source_kind', 'bobsled_source_kind'];
const MANAGED_TYPES = ['dogsled_managed', 'bobsled_managed'];

describe('Blueprint spellings Core reads', () => {
  it('lists both the Dogsled and the Bobsled spelling of every key, type and prefix', () => {
    expect(BLUEPRINT_KEY_SPELLINGS).toEqual([CONNECTION_REF_SPELLINGS, SOURCE_KIND_SPELLINGS]);
    expect(MANAGED_DESTINATION_TYPE_SPELLINGS).toEqual(MANAGED_TYPES);
    expect(BLUEPRINT_EXTENSION_KEY_PREFIXES).toEqual(['dogsled_', 'bobsled_']);
    expect(REJECTED_LEGACY_DESTINATION_TYPES).toEqual({
      bobsled_lakehouse: MANAGED_DESTINATION_TYPE,
    });
  });

  it('maps every other spelling to the current one', () => {
    expect(CONNECTION_REF_SPELLINGS).toContain(BLUEPRINT_CONNECTION_REF_KEY);
    expect(SOURCE_KIND_SPELLINGS).toContain(BLUEPRINT_SOURCE_KIND_KEY);
    expect(MANAGED_TYPES).toContain(MANAGED_DESTINATION_TYPE);
    expect(LEGACY_BLUEPRINT_KEY_ALIASES).toEqual({
      ...Object.fromEntries(
        CONNECTION_REF_SPELLINGS.filter((key) => key !== BLUEPRINT_CONNECTION_REF_KEY).map(
          (key) => [key, BLUEPRINT_CONNECTION_REF_KEY]
        )
      ),
      ...Object.fromEntries(
        SOURCE_KIND_SPELLINGS.filter((key) => key !== BLUEPRINT_SOURCE_KIND_KEY).map((key) => [
          key,
          BLUEPRINT_SOURCE_KIND_KEY,
        ])
      ),
    });
    expect(LEGACY_DESTINATION_TYPE_ALIASES).toEqual(
      Object.fromEntries(
        MANAGED_TYPES.filter((type) => type !== MANAGED_DESTINATION_TYPE).map((type) => [
          type,
          MANAGED_DESTINATION_TYPE,
        ])
      )
    );
  });

  it('treats only the exact managed types as managed, never a prefix match', () => {
    for (const type of MANAGED_TYPES) expect(isManagedDestinationType(type)).toBe(true);
    for (const type of ['bobsled_managed_snowflake', 'dogsled_managed_x', 'snowflake', 3])
      expect(isManagedDestinationType(type)).toBe(false);
  });

  it.each(
    CONNECTION_REF_SPELLINGS.flatMap((ref) => SOURCE_KIND_SPELLINGS.map((kind) => [ref, kind]))
  )('accepts %s and %s in an integration with no warning', (ref, kind) => {
    const document = {
      type: 'source',
      [ref]: 'api',
      [kind]: 'bobsled_api',
      resources: { [ref]: 'user-data' },
    };
    const result = normalizeLegacyBlueprintKeys(document, {
      path: 'integrations/api.yml',
      kind: 'integration',
    });
    expect(result).toEqual({
      document: {
        type: 'source',
        [BLUEPRINT_CONNECTION_REF_KEY]: 'api',
        [BLUEPRINT_SOURCE_KIND_KEY]: 'bobsled_api',
        resources: document.resources,
      },
      deprecations: [],
    });
    expect(document).toHaveProperty(ref, 'api');
  });

  it.each(MANAGED_TYPES.flatMap((type) => CONNECTION_REF_SPELLINGS.map((ref) => [type, ref])))(
    'accepts destination type %s with %s and no warning, leaving nested data alone',
    (type, ref) => {
      const document = {
        type: 'pipeline_config',
        [ref]: 'root-data',
        destinations: {
          warehouse: { type, [ref]: 'warehouse', options: { [ref]: 'user-data' } },
          local: { type: 'local', [ref]: 'local' },
        },
        pipelines: { example: { inputs: { bobsled_source_kind: 'user-data' } } },
      };
      const result = normalizeLegacyBlueprintKeys(document, {
        path: 'pipelines.yml',
        kind: 'pipeline_config',
      });
      expect(result).toEqual({
        document: {
          ...document,
          destinations: {
            warehouse: {
              type: MANAGED_DESTINATION_TYPE,
              [BLUEPRINT_CONNECTION_REF_KEY]: 'warehouse',
              options: document.destinations.warehouse.options,
            },
            local: { type: 'local', [BLUEPRINT_CONNECTION_REF_KEY]: 'local' },
          },
        },
        deprecations: [],
      });
    }
  );

  it.each([CONNECTION_REF_SPELLINGS, SOURCE_KIND_SPELLINGS])(
    'accepts %s and %s together when the values are equal',
    (first, second) => {
      const current =
        first === BLUEPRINT_CONNECTION_REF_KEY || second === BLUEPRINT_CONNECTION_REF_KEY
          ? BLUEPRINT_CONNECTION_REF_KEY
          : BLUEPRINT_SOURCE_KIND_KEY;
      expect(
        normalizeLegacyBlueprintKeys({ [first]: 'same', [second]: 'same' }, { kind: 'integration' })
      ).toEqual({ document: { [current]: 'same' }, deprecations: [] });
    }
  );

  it.each(Object.entries(LEGACY_BLUEPRINT_KEY_ALIASES))(
    'rejects conflicting %s without exposing values',
    (oldKey, newKey) => {
      let failure: unknown;
      try {
        normalizeLegacyBlueprintKeys(
          { [oldKey]: 'private-old', [newKey]: 'private-new' },
          { path: 'integrations/api.yml', kind: 'integration' }
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(LegacyBlueprintKeyConflictError);
      expect(failure).toMatchObject({
        code: 'LEGACY_KEY_CONFLICT',
        path: 'integrations/api.yml',
        oldKey,
        newKey,
      });
      expect((failure as Error).message).toBe(
        `LEGACY_KEY_CONFLICT: integrations/api.yml: ${oldKey} conflicts with ${newKey}`
      );
    }
  );

  it('reports destination conflicts with the file path', () => {
    const [oldKey] = Object.keys(LEGACY_BLUEPRINT_KEY_ALIASES).filter(
      (key) => LEGACY_BLUEPRINT_KEY_ALIASES[key] === BLUEPRINT_CONNECTION_REF_KEY
    );
    expect(() =>
      normalizeLegacyBlueprintKeys(
        {
          destinations: {
            warehouse: {
              type: 'bobsled_managed',
              [oldKey!]: 'private-old',
              [BLUEPRINT_CONNECTION_REF_KEY]: 'private-new',
            },
          },
        },
        { path: 'pipelines.yml', kind: 'pipeline_config' }
      )
    ).toThrow(
      `LEGACY_KEY_CONFLICT: pipelines.yml: ${oldKey} conflicts with ${BLUEPRINT_CONNECTION_REF_KEY}`
    );
  });

  it('keeps retired destinations, source kinds on destinations and unrelated names unchanged', () => {
    const document = { type: 'bobsled_lakehouse', bobsled_unrelated: 'data', bms_config: {} };
    expect(normalizeLegacyBlueprintKeys(document, { kind: 'destination' })).toEqual({
      document,
      deprecations: [],
    });
    for (const key of SOURCE_KIND_SPELLINGS)
      expect(
        normalizeLegacyBlueprintKeys({ [key]: 'user-data' }, { kind: 'destination' }).document
      ).toEqual({ [key]: 'user-data' });
  });

  it.each([null, undefined, 3, 'data', []])('preserves non-object input %s', (document) => {
    expect(normalizeLegacyBlueprintKeys(document, { kind: 'integration' })).toEqual({
      document,
      deprecations: [],
    });
  });
});
