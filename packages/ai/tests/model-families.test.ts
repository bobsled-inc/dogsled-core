import { describe, expect, it } from 'vitest';

import {
  currentModelVersionFor,
  DEFAULT_MODEL_FAMILY_ID,
  MODEL_FAMILIES,
  MODEL_FAMILY_IDS,
  modelFamilyFor,
  RETIRED_MODEL_IDS,
} from '../src/model-families.js';

describe('AI Gateway model families', () => {
  it('has one current model version for each supported family', () => {
    expect(Object.keys(MODEL_FAMILIES).sort()).toEqual([...MODEL_FAMILY_IDS].sort());
    for (const familyId of MODEL_FAMILY_IDS) {
      expect(modelFamilyFor(familyId)).toBe(familyId);
      expect(currentModelVersionFor(familyId)).toBe(MODEL_FAMILIES[familyId].currentVersion);
    }
  });

  it('keeps family, version, and retired IDs aligned with Dogsled', () => {
    const dogSledModelIds = {
      'alibaba/qwen': ['alibaba/qwen3.8-27b'],
      'anthropic/claude-opus': ['anthropic/claude-opus-5.5', 'anthropic/claude-opus-5'],
      'google/gemini-flash': ['google/gemini-3.8-flash'],
      'moonshotai/kimi': ['moonshotai/kimi-k3'],
      'openai/sol': ['openai/gpt-5.6-sol'],
      'zai/glm-flash': ['zai/glm-5.3-flash'],
    } as const;

    for (const familyId of MODEL_FAMILY_IDS) {
      expect([
        MODEL_FAMILIES[familyId].currentVersion,
        ...MODEL_FAMILIES[familyId].previousVersions,
      ]).toEqual(dogSledModelIds[familyId]);
    }
    expect(RETIRED_MODEL_IDS).toEqual([
      'anthropic/claude-sonnet-5',
      'deepseek/deepseek-v4-flash-0731',
      'openai/gpt-5.6-luna',
      'openai/gpt-6-astra',
    ]);
    expect(DEFAULT_MODEL_FAMILY_ID).toBe('zai/glm-flash');
  });

  it('resolves current and previous model IDs to their current family version', () => {
    for (const familyId of MODEL_FAMILY_IDS) {
      const family = MODEL_FAMILIES[familyId];
      expect(modelFamilyFor(family.currentVersion)).toBe(familyId);
      expect(currentModelVersionFor(family.currentVersion)).toBe(family.currentVersion);
      for (const previousVersion of family.previousVersions) {
        expect(modelFamilyFor(previousVersion)).toBe(familyId);
        expect(currentModelVersionFor(previousVersion)).toBe(family.currentVersion);
      }
    }
  });

  it('preserves custom namespaced model IDs', () => {
    expect(modelFamilyFor('vendor/custom-model')).toBeUndefined();
    expect(currentModelVersionFor('vendor/custom-model')).toBe('vendor/custom-model');
  });

  it('maps retired model IDs to the default family', () => {
    for (const modelId of RETIRED_MODEL_IDS) {
      expect(modelFamilyFor(modelId)).toBe(DEFAULT_MODEL_FAMILY_ID);
      expect(currentModelVersionFor(modelId)).toBe(
        MODEL_FAMILIES[DEFAULT_MODEL_FAMILY_ID].currentVersion
      );
    }
  });
});
