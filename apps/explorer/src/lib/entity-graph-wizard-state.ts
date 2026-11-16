import { isPlainObject } from './guards';
import {
  ENTITY_GRAPH_DESIGN_STEPS,
  type EntityGraphDesignStep,
  getEntityGraphDesignStepIndex,
} from './entity-graph-design-flow';
import { type ResolutionSpec } from './entity-graph-design-spec';
import {
  isEntityGraphScenarioId,
  type EntityGraphEntityId,
  type EntityGraphScenarioId,
} from './entity-graph-scenarios';

export const ENTITY_GRAPH_WIZARD_STORAGE_KEY = 'bobsled-explorer-entity_graph-config';

export interface PersistedEntityGraphWizardState {
  scenarioId?: EntityGraphScenarioId;
  entityId?: EntityGraphEntityId;
  step: EntityGraphDesignStep;
  specName: string;
  spec: ResolutionSpec;
  yamlText: string;
  yamlDirty: boolean;
  savedAt: string;
}

interface PersistedEntityGraphWizardStatePayload {
  step?: unknown;
  scenarioId?: unknown;
  entityId?: unknown;
  specName?: unknown;
  spec?: unknown;
  yamlText?: unknown;
  yamlDirty?: unknown;
  savedAt?: unknown;
}

export interface EntityGraphWizardContext {
  scenarioId: EntityGraphScenarioId;
  entityId: EntityGraphEntityId;
}

function isStorageLike(
  value: unknown
): value is Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  return (
    isPlainObject(value) &&
    typeof value.getItem === 'function' &&
    typeof value.setItem === 'function' &&
    typeof value.removeItem === 'function'
  );
}

function getStorage(
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  if (storage) return storage;
  if (typeof window === 'undefined') return null;
  try {
    return isStorageLike(window.localStorage) ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function getEntityGraphWizardStorageKey(context?: EntityGraphWizardContext): string {
  if (!context) return ENTITY_GRAPH_WIZARD_STORAGE_KEY;
  return `${ENTITY_GRAPH_WIZARD_STORAGE_KEY}:${context.scenarioId}:${context.entityId}`;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeResolutionSpec(spec: unknown): ResolutionSpec | null {
  if (!isPlainObject(spec)) return null;

  const normalized: ResolutionSpec = {};

  if (typeof spec.spec_version === 'string') {
    normalized.spec_version = spec.spec_version;
  }
  if (typeof spec.name === 'string') {
    normalized.name = spec.name;
  }
  if (spec.type !== undefined && spec.type !== 'resolution') {
    return null;
  }
  if (typeof spec.type === 'string') {
    normalized.type = spec.type;
  } else {
    normalized.type = 'resolution';
  }
  if (typeof spec.description === 'string') {
    normalized.description = spec.description;
  }

  if (Array.isArray(spec.inputs)) {
    normalized.inputs = spec.inputs.filter(isPlainObject).map((input) => ({
      ref: typeof input.ref === 'string' ? input.ref : '',
      role: typeof input.role === 'string' ? input.role : undefined,
      trust_tier: typeof input.trust_tier === 'string' ? input.trust_tier : undefined,
      id_fields: readStringArray(input.id_fields),
    }));
  } else {
    normalized.inputs = [];
  }

  if (Array.isArray(spec.standardize)) {
    normalized.standardize = spec.standardize.filter(isPlainObject).map((rule) => ({
      field: typeof rule.field === 'string' ? rule.field : '',
      transforms: readStringArray(rule.transforms),
    }));
  } else {
    normalized.standardize = [];
  }

  if (isPlainObject(spec.blocking)) {
    normalized.blocking = {
      rules: Array.isArray(spec.blocking.rules)
        ? spec.blocking.rules.filter(isPlainObject).map((rule) => ({
            name: typeof rule.name === 'string' ? rule.name : '',
            key: typeof rule.key === 'string' ? rule.key : '',
          }))
        : [],
      candidate_limit: readNumber(spec.blocking.candidate_limit),
    };
  }

  if (isPlainObject(spec.scoring)) {
    normalized.scoring = {
      method: typeof spec.scoring.method === 'string' ? spec.scoring.method : undefined,
      features: Array.isArray(spec.scoring.features)
        ? spec.scoring.features.filter(isPlainObject).map((feature) => ({
            field: typeof feature.field === 'string' ? feature.field : '',
            algorithm: typeof feature.algorithm === 'string' ? feature.algorithm : '',
            weight: readNumber(feature.weight) ?? 0,
          }))
        : [],
    };
  }

  if (isPlainObject(spec.thresholds)) {
    normalized.thresholds = {
      auto_merge: readNumber(spec.thresholds.auto_merge),
      review: readNumber(spec.thresholds.review),
      auto_reject: readNumber(spec.thresholds.auto_reject),
    };
  }

  return normalized;
}

export function loadPersistedEntityGraphWizardState(
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
): PersistedEntityGraphWizardState | null {
  const target = getStorage(storage);
  if (!target) return null;

  try {
    const raw = target.getItem(ENTITY_GRAPH_WIZARD_STORAGE_KEY);
    if (!raw) return null;

    const parsedRaw = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsedRaw)) {
      clearPersistedEntityGraphWizardState(target);
      return null;
    }

    const parsed = parsedRaw as PersistedEntityGraphWizardStatePayload;
    const scenarioId = parsed.scenarioId;
    if (scenarioId !== undefined && !isEntityGraphScenarioId(scenarioId)) {
      clearPersistedEntityGraphWizardState(target);
      return null;
    }
    const step =
      typeof parsed.step === 'string' &&
      ENTITY_GRAPH_DESIGN_STEPS.some((entry) => entry.id === parsed.step)
        ? (parsed.step as EntityGraphDesignStep)
        : null;
    const specName = typeof parsed.specName === 'string' ? parsed.specName : null;
    const yamlText = typeof parsed.yamlText === 'string' ? parsed.yamlText : null;
    const yamlDirty = typeof parsed.yamlDirty === 'boolean' ? parsed.yamlDirty : null;
    const savedAt = typeof parsed.savedAt === 'string' ? parsed.savedAt : null;
    const spec = normalizeResolutionSpec(parsed.spec);

    if (!step || !specName || yamlText === null || yamlDirty === null || !savedAt || !spec) {
      clearPersistedEntityGraphWizardState(target);
      return null;
    }

    const entityId =
      parsed.entityId === 'company' ||
      parsed.entityId === 'customer' ||
      parsed.entityId === 'location'
        ? parsed.entityId
        : undefined;

    return {
      ...(scenarioId ? { scenarioId } : {}),
      ...(entityId ? { entityId } : {}),
      step,
      specName,
      spec,
      yamlText,
      yamlDirty,
      savedAt,
    };
  } catch {
    clearPersistedEntityGraphWizardState(target);
    return null;
  }
}

export function savePersistedEntityGraphWizardState(
  state: PersistedEntityGraphWizardState,
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
): void {
  const target = getStorage(storage);
  if (!target) return;
  try {
    target.setItem(ENTITY_GRAPH_WIZARD_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Persistence is best-effort only; restricted browsers should still allow editing.
  }
}

export function clearPersistedEntityGraphWizardState(
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
): void {
  const target = getStorage(storage);
  if (!target) return;
  try {
    target.removeItem(ENTITY_GRAPH_WIZARD_STORAGE_KEY);
  } catch {
    // Ignore storage removal failures so reset remains non-blocking.
  }
}

export function loadPersistedEntityGraphWizardStateForContext(
  context: EntityGraphWizardContext,
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
): PersistedEntityGraphWizardState | null {
  const target = getStorage(storage);
  if (!target) return null;

  const key = getEntityGraphWizardStorageKey(context);
  try {
    const raw = target.getItem(key);
    if (!raw) {
      const legacy = loadPersistedEntityGraphWizardState(target);
      if (!legacy) {
        return null;
      }

      return {
        ...legacy,
        scenarioId: legacy.scenarioId ?? context.scenarioId,
        entityId: legacy.entityId ?? context.entityId,
      };
    }

    const parsedRaw = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsedRaw)) {
      clearPersistedEntityGraphWizardStateForContext(context, target);
      return null;
    }

    const parsed = parsedRaw as PersistedEntityGraphWizardStatePayload;
    const normalized = loadPersistedEntityGraphWizardState({
      getItem(requestedKey) {
        return requestedKey === ENTITY_GRAPH_WIZARD_STORAGE_KEY ? raw : null;
      },
      setItem(requestedKey, value) {
        if (requestedKey === ENTITY_GRAPH_WIZARD_STORAGE_KEY) {
          target.setItem(key, value);
        }
      },
      removeItem(requestedKey) {
        if (requestedKey === ENTITY_GRAPH_WIZARD_STORAGE_KEY) {
          target.removeItem(key);
        }
      },
    });

    if (!normalized) return null;
    const scenarioId = normalized.scenarioId ?? context.scenarioId;
    const entityId =
      parsed.entityId === 'company' ||
      parsed.entityId === 'customer' ||
      parsed.entityId === 'location'
        ? parsed.entityId
        : context.entityId;

    return {
      ...normalized,
      scenarioId,
      entityId,
    };
  } catch {
    clearPersistedEntityGraphWizardStateForContext(context, target);
    return null;
  }
}

export function savePersistedEntityGraphWizardStateForContext(
  context: EntityGraphWizardContext,
  state: PersistedEntityGraphWizardState,
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
): void {
  const target = getStorage(storage);
  if (!target) return;
  try {
    target.setItem(
      getEntityGraphWizardStorageKey(context),
      JSON.stringify({ ...state, scenarioId: context.scenarioId, entityId: context.entityId })
    );
  } catch {
    // Persistence is best-effort only; restricted browsers should still allow editing.
  }
}

export function clearPersistedEntityGraphWizardStateForContext(
  context: EntityGraphWizardContext,
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
): void {
  const target = getStorage(storage);
  if (!target) return;
  try {
    target.removeItem(getEntityGraphWizardStorageKey(context));
  } catch {
    // Ignore storage removal failures so reset remains non-blocking.
  }
}

export function deriveEntityGraphEntityLabel(specName: string, spec?: ResolutionSpec): string {
  const rawName =
    typeof spec?.name === 'string' && spec.name.trim().length > 0 ? spec.name : specName;
  const normalized = rawName
    .replace(/(?:_|-)resolution$/i, '')
    .replace(/(?:_|-)survivorship$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();

  if (!normalized) return 'Entity Graph';

  return normalized.replace(/\b\w/g, (char) => char.toUpperCase());
}

export function describePersistedEntityGraphWizardState(state: PersistedEntityGraphWizardState): {
  entityLabel: string;
  stepIndex: number;
  stepCount: number;
} {
  return {
    entityLabel: deriveEntityGraphEntityLabel(state.specName, state.spec),
    stepIndex: getEntityGraphDesignStepIndex(state.step),
    stepCount: ENTITY_GRAPH_DESIGN_STEPS.length,
  };
}

export function createBlankResolutionSpec(specName: string): ResolutionSpec {
  return {
    spec_version: '0.2',
    name: specName,
    type: 'resolution',
    description: '',
    inputs: [],
    standardize: [],
    blocking: {
      rules: [],
    },
    scoring: {
      method: 'weighted_features',
      features: [],
    },
    thresholds: {
      auto_merge: 0.93,
      review: 0.6,
      auto_reject: 0.5,
    },
  };
}
