export type OutputTableStage =
  | 'identity'
  | 'audit'
  | 'semantic'
  | 'relationship'
  | 'object'
  | 'policy'
  | 'clean'
  | 'expect'
  | 'lineage';

export interface ColumnDef {
  name: string;
  type: string;
  nullable?: boolean;
  description?: string;
}

export interface OutputTableDef<Suffix extends string = string> {
  suffix: Suffix;
  stage: OutputTableStage;
  ddlStrategy: 'create_or_replace' | 'create_if_not_exists';
  kind?: 'table' | 'view';
  visibility?: 'public' | 'internal';
  columns: readonly ColumnDef[];
}

class OutputTableRegistry {
  readonly #tables = new Map<string, OutputTableDef>();

  register(tableOrTables: OutputTableDef | readonly OutputTableDef[]): void {
    const tables = Array.isArray(tableOrTables) ? tableOrTables : [tableOrTables];
    for (const table of tables) {
      const existing = this.#tables.get(table.suffix);
      if (existing && existing.stage !== table.stage) {
        throw new Error(
          `Output table suffix ${table.suffix} is already registered for ${existing.stage}.`
        );
      }
      this.#tables.set(table.suffix, table);
    }
  }

  all(): OutputTableDef[] {
    return [...this.#tables.values()];
  }

  for(stage: OutputTableStage): OutputTableDef[] {
    return this.all().filter((table) => table.stage === stage);
  }

  get(suffix: string): OutputTableDef {
    const def = this.#tables.get(suffix);
    if (!def) {
      throw new Error(`Unknown output table suffix: ${suffix}`);
    }
    return def;
  }

  suffixes(): string[] {
    return this.all().map((table) => table.suffix);
  }

  publicSuffixes(): string[] {
    return this.all()
      .filter((table) => (table.visibility ?? 'public') === 'public')
      .map((table) => table.suffix);
  }
}

export const OUTPUT_TABLES = new OutputTableRegistry();

export function getOutputTableDef(suffix: string): OutputTableDef {
  return OUTPUT_TABLES.get(suffix);
}

/** Build full table name: {entity}{suffix}. */
export function outputTableName(entity: string, suffix: string): string {
  return `${entity}${suffix}`;
}

import { RESOLUTION_OUTPUT_TABLES } from './resolution.js';
import { AUDIT_OUTPUT_TABLES } from './audit.js';
import { SEMANTIC_OUTPUT_TABLES } from './semantic.js';
import { RELATIONSHIP_OUTPUT_TABLES } from './relationship.js';
import { RELATIONSHIP_EDGE_OUTPUT_TABLES } from './relationship-edge.js';
import { MENTION_OUTPUT_TABLES, MENTION_QUALITY_VIEW_TABLES } from './mention.js';
import { OBJECT_OUTPUT_TABLES } from './object.js';
import { LINEAGE_OUTPUT_TABLE } from './lineage.js';

export { AUDIT_OUTPUT_TABLES } from './audit.js';
export { LINEAGE_OUTPUT_TABLE } from './lineage.js';
export { MENTION_OUTPUT_TABLES, MENTION_QUALITY_VIEW_TABLES } from './mention.js';
export { OBJECT_OUTPUT_TABLES } from './object.js';
export {
  RELATIONSHIP_EDGE_OUTPUT_TABLES,
  computeEdgeQuality,
  type EdgeQualityInputs,
  type RelationshipCardinality,
} from './relationship-edge.js';
export { RELATIONSHIP_OUTPUT_TABLES } from './relationship.js';
export { OUTPUT_TABLE_SUFFIXES, RESOLUTION_OUTPUT_TABLES } from './resolution.js';
export { SEMANTIC_OUTPUT_TABLES } from './semantic.js';
export type { OutputTableSuffix } from './resolution.js';

OUTPUT_TABLES.register(RESOLUTION_OUTPUT_TABLES);
OUTPUT_TABLES.register(AUDIT_OUTPUT_TABLES);
OUTPUT_TABLES.register(SEMANTIC_OUTPUT_TABLES);
OUTPUT_TABLES.register(RELATIONSHIP_OUTPUT_TABLES);
OUTPUT_TABLES.register(RELATIONSHIP_EDGE_OUTPUT_TABLES);
OUTPUT_TABLES.register(MENTION_OUTPUT_TABLES);
OUTPUT_TABLES.register(MENTION_QUALITY_VIEW_TABLES);
OUTPUT_TABLES.register(OBJECT_OUTPUT_TABLES);
OUTPUT_TABLES.register(LINEAGE_OUTPUT_TABLE);
