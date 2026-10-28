import type { ResolvedTransformSpec } from '../parser.js';
import type { ExpectSpec } from '../schemas.js';

export interface ParsedModelExpectations {
  modelName: string;
  tableName: string;
  expectations: ExpectSpec[];
  outputColumns: string[];
}

export function collectModelExpectations(
  spec: ResolvedTransformSpec,
  tableName: string,
  inheritedColumns: string[] = []
): ParsedModelExpectations {
  const excludedColumns = new Set(
    (spec.excludeColumns ?? []).map((column) => column.toLowerCase())
  );
  const outputColumns = new Set<string>();
  for (const column of inheritedColumns) {
    if (!excludedColumns.has(column.toLowerCase())) {
      outputColumns.add(column);
    }
  }
  for (const column of spec.columns) {
    if (!excludedColumns.has(column.name.toLowerCase())) {
      outputColumns.add(column.name);
    }
  }
  for (const column of spec.derivedColumns ?? []) {
    if (!excludedColumns.has(column.name.toLowerCase())) {
      outputColumns.add(column.name);
    }
  }

  return {
    modelName: spec.name,
    tableName,
    expectations: spec.expect ?? [],
    outputColumns: [...outputColumns],
  };
}
