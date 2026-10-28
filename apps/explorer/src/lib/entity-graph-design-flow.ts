export interface EntityGraphDesignStepDefinition {
  id:
    | 'overview'
    | 'entity'
    | 'inputs'
    | 'standardize'
    | 'blocking'
    | 'scoring'
    | 'thresholds'
    | 'review';
  label: string;
  optional?: boolean;
}

export const ENTITY_GRAPH_DESIGN_STEPS = [
  { id: 'overview', label: 'Overview' },
  { id: 'entity', label: 'Entity' },
  { id: 'inputs', label: 'Inputs' },
  { id: 'standardize', label: 'Standardize' },
  { id: 'blocking', label: 'Blocking', optional: true },
  { id: 'scoring', label: 'Scoring' },
  { id: 'thresholds', label: 'Thresholds' },
  { id: 'review', label: 'Review' },
] as const satisfies ReadonlyArray<EntityGraphDesignStepDefinition>;

export type EntityGraphDesignStep = (typeof ENTITY_GRAPH_DESIGN_STEPS)[number]['id'];

export function isEntityGraphDesignStep(value: string | null): value is EntityGraphDesignStep {
  return ENTITY_GRAPH_DESIGN_STEPS.some((step) => step.id === value);
}

export function getEntityGraphDesignStepIndex(step: EntityGraphDesignStep): number {
  return ENTITY_GRAPH_DESIGN_STEPS.findIndex((entry) => entry.id === step) + 1;
}
