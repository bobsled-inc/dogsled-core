import { getCanonicalDialect, unsupportedDialectFeatureError } from '../dialect.js';
import type { SupportedDialect } from '../dialect.js';
import type { FunctionDef } from './functions.js';

function normalizedEditDistance(args: string[], dialect: SupportedDialect): string {
  const [left, right] = args;
  if (!left || !right) {
    throw new Error('levenshtein similarity helper requires two arguments');
  }

  if (dialect === 'redshift') {
    throw unsupportedDialectFeatureError(
      dialect,
      'fuzzy:edit_distance',
      'levenshtein is not supported for compiler target "redshift".'
    );
  }

  switch (getCanonicalDialect(dialect)) {
    case 'snowflake':
      return `EDITDISTANCE(${left}, ${right})`;
    case 'bigquery':
      return `EDIT_DISTANCE(${left}, ${right})`;
    case 'postgres':
      return `levenshtein(${left}, ${right})`;
    case 'duckdb':
      return `levenshtein(${left}, ${right})`;
    case 'databricks':
      return `levenshtein(${left}, ${right})`;
    case 'clickhouse':
      // `editDistance` counts bytes rather than characters; the character-exact
      // `editDistanceUTF8` only arrived in 24.6 and the compiler cannot see the
      // server version.
      return `editDistance(${left}, ${right})`;
    case 'mysql':
      throw unsupportedDialectFeatureError(
        dialect,
        'fuzzy:edit_distance',
        'levenshtein is not supported for compiler target "mysql".'
      );
  }
}

/**
 * Prefix-boosted normalized edit-distance approximation of Jaro-Winkler, for
 * dialects with a native edit-distance function but no native Jaro-Winkler:
 * `sim + p * 0.1 * (1 - sim)` where `sim = 1 - dist / max(len)` and `p` is the
 * common-prefix length capped at 4 (Winkler's adjustment). Inlined because the
 * expression DSL has no temp-function preamble mechanism; a BigQuery JS UDF is
 * orders of magnitude slower than this native expression.
 */
function prefixBoostedEditDistanceJw(left: string, right: string, distanceFn: string): string {
  const dist = `${distanceFn}(${left}, ${right}) / GREATEST(LENGTH(${left}), LENGTH(${right}), 1)`;
  const prefix =
    `CASE WHEN SUBSTR(${left}, 1, 4) = SUBSTR(${right}, 1, 4) THEN 4 ` +
    `WHEN SUBSTR(${left}, 1, 3) = SUBSTR(${right}, 1, 3) THEN 3 ` +
    `WHEN SUBSTR(${left}, 1, 2) = SUBSTR(${right}, 1, 2) THEN 2 ` +
    `WHEN SUBSTR(${left}, 1, 1) = SUBSTR(${right}, 1, 1) THEN 1 ` +
    `ELSE 0 END`;
  return (
    `CASE WHEN ${left} IS NULL OR ${right} IS NULL OR LENGTH(${left}) = 0 OR LENGTH(${right}) = 0 THEN 0.0 ` +
    `WHEN ${left} = ${right} THEN 1.0 ` +
    `ELSE (1.0 - ${dist}) + ${prefix} * 0.1 * (${dist}) END`
  );
}

function jaroWinkler(args: string[], dialect: SupportedDialect): string {
  const [left, right] = args;
  if (!left || !right) {
    throw new Error('jaro_winkler requires two arguments');
  }

  if (dialect === 'redshift') {
    throw unsupportedDialectFeatureError(
      dialect,
      'fuzzy:jaro_winkler',
      'jaro_winkler is not supported for compiler target "redshift".'
    );
  }

  switch (getCanonicalDialect(dialect)) {
    case 'snowflake':
      return `JAROWINKLER_SIMILARITY(${left}, ${right}) / 100.0`;
    case 'bigquery':
      return prefixBoostedEditDistanceJw(left, right, 'EDIT_DISTANCE');
    case 'postgres':
      return `similarity(${left}, ${right})`;
    case 'duckdb':
      return `jaro_winkler_similarity(${left}, ${right})`;
    case 'databricks':
      return prefixBoostedEditDistanceJw(left, right, 'levenshtein');
    case 'clickhouse':
      // The prefix-boosted approximation above would compile here, but the
      // ClickHouse profile declares jaro_winkler unsupported, so emitting one
      // would contradict the capability every planner reads.
      throw unsupportedDialectFeatureError(
        dialect,
        'fuzzy:jaro_winkler',
        'jaro_winkler is not supported for compiler target "clickhouse".'
      );
    case 'mysql':
      throw unsupportedDialectFeatureError(
        dialect,
        'fuzzy:jaro_winkler',
        'jaro_winkler is not supported for compiler target "mysql".'
      );
  }
}

function metaphone(args: string[], dialect: SupportedDialect): string {
  const [value, length] = args;
  if (!value) {
    throw new Error('metaphone requires at least one argument');
  }

  if (dialect === 'postgres' || dialect === 'pgvector') {
    return `metaphone(${value}, ${length ?? '4'})`;
  }

  throw unsupportedDialectFeatureError(
    dialect,
    'fuzzy:metaphone',
    `metaphone is not supported for compiler target "${dialect}".`
  );
}

function soundex(args: string[], dialect: SupportedDialect): string {
  const [value] = args;
  if (!value) {
    throw new Error('soundex requires one argument');
  }

  if (dialect === 'redshift') {
    return `SOUNDEX(${value})`;
  }

  switch (getCanonicalDialect(dialect)) {
    case 'snowflake':
    case 'bigquery':
    case 'mysql':
      return `SOUNDEX(${value})`;
    case 'postgres':
    case 'duckdb':
    case 'databricks':
    case 'clickhouse':
      return `soundex(${value})`;
  }
}

export const FUZZY_FUNCTIONS: FunctionDef[] = [
  {
    name: 'jaro_winkler',
    minArgs: 2,
    maxArgs: 2,
    category: 'fuzzy',
    description: 'Returns a 0..1 string similarity score for two strings.',
    signature: {
      args: [
        { name: 'left', type: 'string' },
        { name: 'right', type: 'string' },
      ],
      returns: 'number',
    },
    examples: ['jaro_winkler(company_name, candidate_name) > 0.92'],
    emit: {
      snowflake: jaroWinkler,
      bigquery: jaroWinkler,
      postgres: jaroWinkler,
      pgvector: jaroWinkler,
      redshift: jaroWinkler,
      duckdb: jaroWinkler,
      databricks: jaroWinkler,
      clickhouse: jaroWinkler,
      mysql: jaroWinkler,
    },
  },
  {
    name: 'levenshtein',
    minArgs: 2,
    maxArgs: 2,
    category: 'fuzzy',
    description: 'Returns the edit distance between two strings.',
    signature: {
      args: [
        { name: 'left', type: 'string' },
        { name: 'right', type: 'string' },
      ],
      returns: 'integer',
    },
    examples: ['levenshtein(normalized_name, candidate_name) <= 2'],
    emit: {
      snowflake: normalizedEditDistance,
      bigquery: normalizedEditDistance,
      postgres: normalizedEditDistance,
      pgvector: normalizedEditDistance,
      redshift: normalizedEditDistance,
      duckdb: normalizedEditDistance,
      databricks: normalizedEditDistance,
      clickhouse: normalizedEditDistance,
      mysql: normalizedEditDistance,
    },
  },
  {
    name: 'soundex',
    minArgs: 1,
    maxArgs: 1,
    category: 'fuzzy',
    description: 'Returns a phonetic Soundex code for a string.',
    signature: {
      args: [{ name: 'value', type: 'string' }],
      returns: 'string',
    },
    examples: ['soundex(company_name) = soundex(candidate_name)'],
    emit: {
      snowflake: soundex,
      bigquery: soundex,
      postgres: soundex,
      pgvector: soundex,
      redshift: soundex,
      duckdb: soundex,
      databricks: soundex,
      clickhouse: soundex,
      mysql: soundex,
    },
  },
  {
    name: 'metaphone',
    minArgs: 1,
    maxArgs: 2,
    category: 'fuzzy',
    description: 'Returns a phonetic Metaphone code for a string where supported.',
    signature: {
      args: [
        { name: 'value', type: 'string' },
        { name: 'max_length', type: 'integer', optional: true },
      ],
      returns: 'string',
    },
    examples: ['metaphone(company_name) = metaphone(candidate_name)'],
    emit: {
      snowflake: metaphone,
      bigquery: metaphone,
      postgres: metaphone,
      pgvector: metaphone,
      redshift: metaphone,
      duckdb: metaphone,
      databricks: metaphone,
      clickhouse: metaphone,
      mysql: metaphone,
    },
  },
];
