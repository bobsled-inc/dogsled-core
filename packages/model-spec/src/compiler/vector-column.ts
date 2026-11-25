import { z } from 'zod';

import type { EmbeddedFrom } from '@bobsled-inc/protocol';

/**
 * `VECTOR` is a first-class Model Spec column type for embedding columns; the
 * compiler maps it per-dialect (Snowflake `VECTOR(FLOAT,N)`, BigQuery
 * `ARRAY<FLOAT64>`, DuckDB `FLOAT[N]`, pgvector `vector(N)`) at DDL time.
 * Matches codegen's normalization (uppercase only, no trim) so a typo like
 * ' VECTOR ' fails validation rather than falling through as raw SQL.
 */
export function refineVectorColumn(
  data: { type: string; dimension?: number; embedded_from?: EmbeddedFrom },
  ctx: z.RefinementCtx
): void {
  const isVector = data.type.toUpperCase() === 'VECTOR';
  const issue = (path: string, message: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  };
  if (isVector && data.dimension === undefined) {
    issue('dimension', 'VECTOR columns require a positive integer dimension');
  }
  if (!isVector && data.dimension !== undefined) {
    issue('dimension', 'dimension is only valid for VECTOR columns');
  }
  if (!isVector && data.embedded_from !== undefined) {
    issue('embedded_from', 'embedded_from is only valid for VECTOR columns');
  }
  const embeddedDimension = data.embedded_from?.dimension;
  if (isVector && embeddedDimension !== undefined && embeddedDimension !== data.dimension) {
    issue('embedded_from', 'embedded_from.dimension must equal the column dimension');
  }
}
