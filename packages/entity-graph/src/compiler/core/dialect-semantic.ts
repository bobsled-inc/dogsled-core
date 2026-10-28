import type { SupportedDialect } from '@bobsled-inc/model-spec';

export interface SemanticSimilarityOptions {
  leftVector: string;
  rightVector: string;
  dialect: SupportedDialect;
}

export function semanticSimilarityExpr(options: SemanticSimilarityOptions): string {
  const left = options.leftVector;
  const right = options.rightVector;

  switch (options.dialect) {
    case 'duckdb':
      return `array_cosine_similarity(${left}, ${right})`;
    case 'bigquery':
      return `(SELECT SAFE_DIVIDE(SUM(l_value * r_value), SQRT(SUM(l_value * l_value)) * SQRT(SUM(r_value * r_value))) FROM UNNEST(${left}) AS l_value WITH OFFSET l_index JOIN UNNEST(${right}) AS r_value WITH OFFSET r_index ON l_index = r_index)`;
    case 'postgres':
    case 'pgvector':
    case 'redshift':
      return `(SELECT SUM(l.value * r.value) / NULLIF(SQRT(SUM(l.value * l.value)) * SQRT(SUM(r.value * r.value)), 0) FROM unnest(${left}) WITH ORDINALITY AS l(value, index) JOIN unnest(${right}) WITH ORDINALITY AS r(value, index) ON l.index = r.index)`;
    case 'snowflake':
      return `(SELECT SUM(l.value::FLOAT * r.value::FLOAT) / NULLIF(SQRT(SUM(l.value::FLOAT * l.value::FLOAT)) * SQRT(SUM(r.value::FLOAT * r.value::FLOAT)), 0) FROM TABLE(FLATTEN(input => ${left})) l JOIN TABLE(FLATTEN(input => ${right})) r ON l.index = r.index)`;
    case 'databricks':
      return `(aggregate(zip_with(${left}, ${right}, (l, r) -> l * r), 0D, (acc, x) -> acc + x) / nullif(sqrt(aggregate(${left}, 0D, (acc, x) -> acc + x * x)) * sqrt(aggregate(${right}, 0D, (acc, x) -> acc + x * x)), 0D))`;
    case 'mysql':
      return `(SELECT SUM(l.value * r.value) / NULLIF(SQRT(SUM(l.value * l.value)) * SQRT(SUM(r.value * r.value)), 0) FROM JSON_TABLE(${left}, '$[*]' COLUMNS (idx FOR ORDINALITY, value DOUBLE PATH '$')) AS l JOIN JSON_TABLE(${right}, '$[*]' COLUMNS (idx FOR ORDINALITY, value DOUBLE PATH '$')) AS r ON l.idx = r.idx)`;
    default:
      return `array_cosine_similarity(${left}, ${right})`;
  }
}
