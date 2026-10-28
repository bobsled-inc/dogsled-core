export const MODEL_FAMILY_IDS = [
  'zai/glm-flash',
  'alibaba/qwen',
  'moonshotai/kimi',
  'openai/sol',
  'google/gemini-flash',
  'anthropic/claude-opus',
] as const;

export type ModelFamilyId = (typeof MODEL_FAMILY_IDS)[number];
export const DEFAULT_MODEL_FAMILY_ID = 'zai/glm-flash' as const satisfies ModelFamilyId;

export const RETIRED_MODEL_IDS = [
  'anthropic/claude-sonnet-5',
  'deepseek/deepseek-v4-flash-0731',
  'openai/gpt-5.6-luna',
  'openai/gpt-6-astra',
] as const;

type ModelFamily = {
  readonly currentVersion: string;
  readonly description: string;
  readonly label: string;
  readonly previousVersions: ReadonlyArray<string>;
};

export const MODEL_FAMILIES = {
  'anthropic/claude-opus': {
    currentVersion: 'anthropic/claude-opus-5.5',
    description: 'Deep reasoning for the most demanding tasks',
    label: 'Claude Opus',
    previousVersions: ['anthropic/claude-opus-5'],
  },
  'openai/sol': {
    currentVersion: 'openai/gpt-5.6-sol',
    description: 'Reasoning for complex analytical work',
    label: 'Sol',
    previousVersions: [],
  },
  'google/gemini-flash': {
    currentVersion: 'google/gemini-3.8-flash',
    description: 'Fast multimodal reasoning for chat and analysis',
    label: 'Gemini Flash',
    previousVersions: [],
  },
  'moonshotai/kimi': {
    currentVersion: 'moonshotai/kimi-k3',
    description: 'Open multimodal reasoning for demanding analysis',
    label: 'Kimi',
    previousVersions: [],
  },
  'zai/glm-flash': {
    currentVersion: 'zai/glm-5.3-flash',
    description: 'Fast open multimodal reasoning for chat and analysis',
    label: 'GLM Flash',
    previousVersions: [],
  },
  'alibaba/qwen': {
    currentVersion: 'alibaba/qwen3.8-27b',
    description: 'Very fast open reasoning for quick questions',
    label: 'Qwen',
    previousVersions: [],
  },
} as const satisfies Record<ModelFamilyId, ModelFamily>;

const familyIds = new Set<string>(MODEL_FAMILY_IDS);
const retiredModelIds = new Set<string>(RETIRED_MODEL_IDS);
const currentVersionByFamily = new Map<string, string>(
  MODEL_FAMILY_IDS.map((id) => [id, MODEL_FAMILIES[id].currentVersion])
);
const familyByModelId = new Map<string, ModelFamilyId>(
  MODEL_FAMILY_IDS.flatMap((id) =>
    [MODEL_FAMILIES[id].currentVersion, ...MODEL_FAMILIES[id].previousVersions].map(
      (modelId) => [modelId, id] as const
    )
  )
);
const currentVersionByModelId = new Map<string, string>(
  MODEL_FAMILY_IDS.flatMap((id) =>
    [MODEL_FAMILIES[id].currentVersion, ...MODEL_FAMILIES[id].previousVersions].map(
      (modelId) => [modelId, MODEL_FAMILIES[id].currentVersion] as const
    )
  )
);

export function modelFamilyFor(modelId: string): ModelFamilyId | undefined {
  if (familyIds.has(modelId)) return modelId as ModelFamilyId;
  return (
    familyByModelId.get(modelId) ??
    (retiredModelIds.has(modelId) ? DEFAULT_MODEL_FAMILY_ID : undefined)
  );
}

export function currentModelVersionFor(modelId: string): string {
  return (
    currentVersionByFamily.get(modelId) ??
    currentVersionByModelId.get(modelId) ??
    (retiredModelIds.has(modelId)
      ? currentVersionByFamily.get(DEFAULT_MODEL_FAMILY_ID)
      : undefined) ??
    modelId
  );
}
