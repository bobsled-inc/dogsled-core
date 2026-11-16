import { LEARN_MODULES } from './learn-modules';
import type { ExplorerBobsledCommand } from './command-links';
import type { EntityGraphTableSuffix } from './learn-entity-graph-atlas';

export { ENTITY_GRAPH_TABLE_ATLAS, isEntityGraphTableSuffix } from './learn-entity-graph-atlas';
export type {
  EntityGraphTableAtlasEntry,
  EntityGraphTableSuffix,
} from './learn-entity-graph-atlas';
export { LEARN_MODULES } from './learn-modules';

export const LEARN_CURRICULUM_VERSION = '2026-05-13.v7';

export type LearnStepKind =
  'concept' | 'surface' | 'command' | 'query' | 'table' | 'spec' | 'check';

export interface LearnAction {
  label: string;
  href: string;
  autoCompletes?: boolean;
}

export interface LearnStep {
  id: string;
  kind: LearnStepKind;
  title: string;
  body: string;
  cliLessonId?: string;
  command?: ExplorerBobsledCommand;
  sql?: string;
  tableSuffix?: EntityGraphTableSuffix;
  action?: LearnAction;
}

export interface LearnModule {
  id: string;
  title: string;
  group: LearnModuleGroup;
  description: string;
  outcome: string;
  estimatedMinutes: number;
  cliPhaseIds: string[];
  credentialEnvVars?: string[];
  steps: LearnStep[];
}

export type LearnModuleGroup =
  | 'foundations'
  | 'bobsled-model-spec-context'
  | 'entity-graph'
  | 'mcp-extraction'
  | 'advanced-elt'
  | 'warehouses';

export interface LearnModuleGroupDefinition {
  id: LearnModuleGroup;
  label: string;
  description: string;
}

export const LEARN_MODULE_GROUPS: LearnModuleGroupDefinition[] = [
  {
    id: 'foundations',
    label: 'Foundations',
    description:
      'CLI basics, local projects, and the Explorer surfaces that make Dogsled inspectable.',
  },
  {
    id: 'bobsled-model-spec-context',
    label: 'Model Spec and Context',
    description: 'Model specs, semantic context, verified queries, and local data inspection.',
  },
  {
    id: 'entity-graph',
    label: 'Entity Graph',
    description: 'Resolution, review, clustering, survivorship, lineage, and output tables.',
  },
  {
    id: 'mcp-extraction',
    label: 'MCP Extraction',
    description: 'Tool-based extraction through the MCP client without importing CLI runtime.',
  },
  {
    id: 'advanced-elt',
    label: 'Advanced Extract and Load',
    description: 'Pagination, auth, incremental sync, loading modes, and pipeline handoff.',
  },
  {
    id: 'warehouses',
    label: 'Warehouses',
    description: 'Warehouse sources, analytical destinations, dialects, and operational checks.',
  },
];

export function getLearnModuleById(id: string): LearnModule | undefined {
  return LEARN_MODULES.find((module) => module.id === id);
}

export function getLearnGroupById(id: LearnModuleGroup): LearnModuleGroupDefinition {
  const group = LEARN_MODULE_GROUPS.find((entry) => entry.id === id);
  if (!group) {
    throw new Error(`Missing learn module group definition for "${id}" in LEARN_MODULE_GROUPS`);
  }
  return group;
}

export function getLearnStepCount(module: LearnModule): number {
  return module.steps.length;
}

export function getCliPhaseCoverage(): string[] {
  return Array.from(new Set(LEARN_MODULES.flatMap((module) => module.cliPhaseIds))).sort();
}
