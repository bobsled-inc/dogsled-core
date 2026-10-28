import { describe, expect, it } from 'vitest';

import {
  DOGSLED_LEGACY_BLUEPRINT_KEY,
  LEGACY_BLUEPRINT_KEY_ALIASES,
  LEGACY_DESTINATION_TYPE_ALIASES,
  LegacyBlueprintKeyConflictError,
  formatLegacyBlueprintDeprecation,
  normalizeLegacyBlueprintKeys,
} from '../../src/index.js';

describe('legacy Blueprint aliases', () => {
  it('exposes only the approved aliases and stable deprecation code', () => {
    expect(LEGACY_BLUEPRINT_KEY_ALIASES).toEqual({
      bobsled_connection_ref: 'dogsled_connection_ref',
      bobsled_source_kind: 'dogsled_source_kind',
    });
    expect(LEGACY_DESTINATION_TYPE_ALIASES).toEqual({ bobsled_managed: 'dogsled_managed' });
    expect(DOGSLED_LEGACY_BLUEPRINT_KEY).toBe('DOGSLED_LEGACY_BLUEPRINT_KEY');
  });

  it('normalizes source keys without changing provider names, nested keys, or the input', () => {
    const document = {
      type: 'source',
      bobsled_connection_ref: 'api',
      bobsled_source_kind: 'bobsled_api',
      resources: { bobsled_connection_ref: 'user-data' },
    };
    const result = normalizeLegacyBlueprintKeys(document, {
      path: 'integrations/api.yml',
      kind: 'integration',
    });
    expect(result.document).toEqual({
      type: 'source',
      dogsled_connection_ref: 'api',
      dogsled_source_kind: 'bobsled_api',
      resources: document.resources,
    });
    expect(document).toHaveProperty('bobsled_connection_ref', 'api');
    expect(result.deprecations).toEqual([
      {
        code: DOGSLED_LEGACY_BLUEPRINT_KEY,
        path: 'integrations/api.yml',
        oldKey: 'bobsled_connection_ref',
        newKey: 'dogsled_connection_ref',
      },
      {
        code: DOGSLED_LEGACY_BLUEPRINT_KEY,
        path: 'integrations/api.yml',
        oldKey: 'bobsled_source_kind',
        newKey: 'dogsled_source_kind',
      },
    ]);
    expect(
      normalizeLegacyBlueprintKeys(result.document, { kind: 'integration' }).deprecations
    ).toEqual([]);
  });

  it('normalizes each destination without rewriting nested user data or unrelated root keys', () => {
    const document = {
      type: 'pipeline_config',
      bobsled_connection_ref: 'root-data',
      destinations: {
        warehouse: {
          type: 'bobsled_managed',
          bobsled_connection_ref: 'warehouse',
          options: { bobsled_connection_ref: 'user-data' },
        },
        local: { type: 'local', bobsled_connection_ref: 'local' },
      },
      pipelines: { example: { inputs: { bobsled_source_kind: 'user-data' } } },
    };
    const result = normalizeLegacyBlueprintKeys(document, {
      path: 'pipelines.yml',
      kind: 'pipeline_config',
    });
    expect(result.document).toEqual({
      ...document,
      destinations: {
        warehouse: {
          type: 'dogsled_managed',
          dogsled_connection_ref: 'warehouse',
          options: document.destinations.warehouse.options,
        },
        local: { type: 'local', dogsled_connection_ref: 'local' },
      },
    });
    expect(result.deprecations).toHaveLength(3);
  });

  it.each(Object.entries(LEGACY_BLUEPRINT_KEY_ALIASES))(
    'drops equal duplicate %s with a deprecation',
    (oldKey, newKey) => {
      const result = normalizeLegacyBlueprintKeys(
        { [oldKey]: 'same', [newKey]: 'same' },
        { kind: 'integration' }
      );
      expect(result.document).toEqual({ [newKey]: 'same' });
      expect(result.deprecations).toHaveLength(1);
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
    expect(() =>
      normalizeLegacyBlueprintKeys(
        {
          destinations: {
            warehouse: {
              type: 'bobsled_managed',
              bobsled_connection_ref: 'private-old',
              dogsled_connection_ref: 'private-new',
            },
          },
        },
        { path: 'pipelines.yml', kind: 'pipeline_config' }
      )
    ).toThrow(
      'LEGACY_KEY_CONFLICT: pipelines.yml: bobsled_connection_ref conflicts with dogsled_connection_ref'
    );
  });

  it('normalizes a bare destination with an explicit kind and omits absent paths', () => {
    const { document, deprecations } = normalizeLegacyBlueprintKeys(
      { type: 'bobsled_managed', bobsled_connection_ref: 'binding' },
      { kind: 'destination' }
    );
    expect(document).toEqual({ type: 'dogsled_managed', dogsled_connection_ref: 'binding' });
    expect(deprecations).toHaveLength(2);
    expect(formatLegacyBlueprintDeprecation(deprecations[0]!)).toBe(
      'DOGSLED_LEGACY_BLUEPRINT_KEY: bobsled_connection_ref is deprecated; use dogsled_connection_ref'
    );
    expect(() =>
      normalizeLegacyBlueprintKeys(
        { bobsled_connection_ref: 'old', dogsled_connection_ref: 'new' },
        { kind: 'destination' }
      )
    ).toThrow('LEGACY_KEY_CONFLICT: bobsled_connection_ref conflicts with dogsled_connection_ref');
  });

  it('keeps retired destinations and unrelated legacy-looking names unchanged', () => {
    const document = { type: 'bobsled_lakehouse', bobsled_unrelated: 'data', bms_config: {} };
    expect(normalizeLegacyBlueprintKeys(document, { kind: 'destination' })).toEqual({
      document,
      deprecations: [],
    });
    expect(
      normalizeLegacyBlueprintKeys({ bobsled_source_kind: 'user-data' }, { kind: 'destination' })
        .deprecations
    ).toEqual([]);
  });

  it.each([null, undefined, 3, 'data', []])('preserves non-object input %s', (document) => {
    expect(normalizeLegacyBlueprintKeys(document, { kind: 'integration' })).toEqual({
      document,
      deprecations: [],
    });
  });

  it('formats warnings using only fixed names and the supplied file path', () => {
    const { deprecations } = normalizeLegacyBlueprintKeys(
      { bobsled_connection_ref: 'private-value' },
      { path: 'integrations/api.yml', kind: 'integration' }
    );
    expect(formatLegacyBlueprintDeprecation(deprecations[0]!)).toBe(
      'DOGSLED_LEGACY_BLUEPRINT_KEY: integrations/api.yml: bobsled_connection_ref is deprecated; use dogsled_connection_ref'
    );
  });
});
