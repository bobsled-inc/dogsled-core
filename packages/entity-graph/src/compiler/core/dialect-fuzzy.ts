/**
 * Dialect-specific fuzzy matching SQL functions.
 *
 * Maps fuzzy algorithms to dialect-appropriate SQL expressions.
 * Includes the BigQuery Jaro-Winkler SQL UDF preamble.
 */

import {
  getCanonicalDialect,
  supportsFuzzyAlgorithm,
  unsupportedDialectFeatureError,
} from '@bobsled-inc/model-spec';

import type { CanonicalDialect, SupportedDialect } from '@bobsled-inc/model-spec';
import type { FuzzyAlgorithm } from '../identity/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FuzzyFunctions {
  jaroWinkler(left: string, right: string): string;
  editDistanceSimilarity(left: string, right: string): string;
  soundexMatch(left: string, right: string): string;
  exact(left: string, right: string): string;
  numericDistance(left: string, right: string): string;
  dateProximity(left: string, right: string): string;
  tokenCosine(left: string, right: string): string;
}

const FUZZY_ALGORITHMS: readonly FuzzyAlgorithm[] = [
  'exact',
  'jaro_winkler',
  'edit_distance',
  'soundex',
  'numeric_distance',
  'date_proximity',
  'token_cosine',
];

// ---------------------------------------------------------------------------
// Per-dialect implementations
// ---------------------------------------------------------------------------

/**
 * Prefix-boosted normalized edit-distance approximation of Jaro-Winkler, for
 * dialects with a native edit-distance function but no native Jaro-Winkler:
 * `sim + p * 0.1 * (1 - sim)` where `sim = 1 - dist / max(len)` and `p` is the
 * common-prefix length capped at 4 (Winkler's adjustment). Mirrors the body of
 * `BIGQUERY_JARO_WINKLER_UDF` so UDF-less dialects rank pairs consistently.
 */
function prefixBoostedEditDistanceJw(l: string, r: string, distanceFn: string): string {
  const dist = `${distanceFn}(${l}, ${r}) / GREATEST(LENGTH(${l}), LENGTH(${r}), 1)`;
  const prefix =
    `CASE WHEN SUBSTR(${l}, 1, 4) = SUBSTR(${r}, 1, 4) THEN 4 ` +
    `WHEN SUBSTR(${l}, 1, 3) = SUBSTR(${r}, 1, 3) THEN 3 ` +
    `WHEN SUBSTR(${l}, 1, 2) = SUBSTR(${r}, 1, 2) THEN 2 ` +
    `WHEN SUBSTR(${l}, 1, 1) = SUBSTR(${r}, 1, 1) THEN 1 ` +
    `ELSE 0 END`;
  return (
    `CASE WHEN ${l} IS NULL OR ${r} IS NULL OR LENGTH(${l}) = 0 OR LENGTH(${r}) = 0 THEN 0.0 ` +
    `WHEN ${l} = ${r} THEN 1.0 ` +
    `ELSE (1.0 - ${dist}) + ${prefix} * 0.1 * (${dist}) END`
  );
}

function tokenCosineEmptyGuard(l: string, r: string): string {
  return `${l} IS NULL OR ${r} IS NULL OR LENGTH(TRIM(${l})) = 0 OR LENGTH(TRIM(${r})) = 0`;
}

function tokenSetSizeSnowflake(expr: string): string {
  return `ARRAY_SIZE(ARRAY_DISTINCT(SPLIT(REGEXP_REPLACE(TRIM(${expr}), '\\\\s+', ' '), ' ')))`;
}

function tokenSetSnowflake(expr: string): string {
  return `ARRAY_DISTINCT(SPLIT(REGEXP_REPLACE(TRIM(${expr}), '\\\\s+', ' '), ' '))`;
}

function tokenSetSizeSpark(expr: string): string {
  return `SIZE(ARRAY_DISTINCT(FILTER(SPLIT(REGEXP_REPLACE(TRIM(${expr}), '\\\\s+', ' '), ' '), token -> token != '')))`;
}

function tokenSetSpark(expr: string): string {
  return `ARRAY_DISTINCT(FILTER(SPLIT(REGEXP_REPLACE(TRIM(${expr}), '\\\\s+', ' '), ' '), token -> token != ''))`;
}

function tokenSetRowsPostgres(expr: string): string {
  return (
    `SELECT DISTINCT token FROM unnest(string_to_array(` +
    `regexp_replace(TRIM(${expr}), '\\\\s+', ' ', 'g'), ' ')) AS token_rows(token) ` +
    `WHERE token <> ''`
  );
}

function tokenSetRowsDuckdb(expr: string): string {
  return (
    `SELECT DISTINCT token FROM UNNEST(string_split(` +
    `regexp_replace(TRIM(${expr}), '[[:space:]]+', ' ', 'g'), ' ')) AS token_rows(token) ` +
    `WHERE token <> ''`
  );
}

function tokenSetRowsRedshift(expr: string): string {
  return (
    `SELECT DISTINCT token::VARCHAR AS token FROM (` +
    `SELECT SPLIT_TO_ARRAY(REGEXP_REPLACE(TRIM(${expr}), '\\\\s+', ' '), ' ') AS tokens` +
    `) token_src, token_src.tokens token WHERE token::VARCHAR <> ''`
  );
}

function tokenCosineFromSetRows(
  l: string,
  r: string,
  leftRows: string,
  rightRows: string,
  doubleType: 'DOUBLE' | 'DOUBLE PRECISION'
): string {
  const intersectionCount =
    `CAST((SELECT COUNT(*) FROM (` +
    `${leftRows} INTERSECT ${rightRows}` +
    `) intersection_tokens) AS ${doubleType})`;
  const leftCount = `CAST((SELECT COUNT(*) FROM (${leftRows}) left_tokens) AS ${doubleType})`;
  const rightCount = `CAST((SELECT COUNT(*) FROM (${rightRows}) right_tokens) AS ${doubleType})`;
  const score = `COALESCE(${intersectionCount} / NULLIF(SQRT(${leftCount} * ${rightCount}), 0.0), 0.0)`;

  return (
    `CASE WHEN ${tokenCosineEmptyGuard(l, r)} THEN 0.0 ELSE ` +
    `LEAST(1.0, GREATEST(0.0, ${score})) END`
  );
}

function tokenCosineSnowflake(l: string, r: string): string {
  const leftSet = tokenSetSnowflake(l);
  const rightSet = tokenSetSnowflake(r);
  const leftSize = tokenSetSizeSnowflake(l);
  const rightSize = tokenSetSizeSnowflake(r);
  return (
    `CASE WHEN ${tokenCosineEmptyGuard(l, r)} THEN 0.0 ELSE ` +
    `LEAST(1.0, GREATEST(0.0, ARRAY_SIZE(ARRAY_INTERSECTION(${leftSet}, ${rightSet})) / ` +
    `NULLIF(SQRT(${leftSize} * ${rightSize}), 0.0))) END`
  );
}

function tokenCosineSpark(l: string, r: string): string {
  const leftSet = tokenSetSpark(l);
  const rightSet = tokenSetSpark(r);
  const leftSize = tokenSetSizeSpark(l);
  const rightSize = tokenSetSizeSpark(r);
  return (
    `CASE WHEN ${tokenCosineEmptyGuard(l, r)} THEN 0.0 ELSE ` +
    `LEAST(1.0, GREATEST(0.0, SIZE(ARRAY_INTERSECT(${leftSet}, ${rightSet})) / ` +
    `NULLIF(SQRT(${leftSize} * ${rightSize}), 0.0))) END`
  );
}

function snowflakeFuzzy(): FuzzyFunctions {
  return {
    jaroWinkler: (l, r) => `JAROWINKLER_SIMILARITY(${l}, ${r}) / 100.0`,
    editDistanceSimilarity: (l, r) =>
      `1.0 - EDITDISTANCE(${l}, ${r}) / GREATEST(LEN(${l}), LEN(${r}), 1)`,
    soundexMatch: (l, r) => `CASE WHEN SOUNDEX(${l}) = SOUNDEX(${r}) THEN 1.0 ELSE 0.0 END`,
    exact: (l, r) => `CASE WHEN ${l} = ${r} THEN 1.0 ELSE 0.0 END`,
    numericDistance: (l, r) =>
      `1.0 - ABS(CAST(${l} AS FLOAT) - CAST(${r} AS FLOAT)) / GREATEST(ABS(CAST(${l} AS FLOAT)), ABS(CAST(${r} AS FLOAT)), 1.0)`,
    dateProximity: (l, r) =>
      `GREATEST(0.0, 1.0 - ABS(DATEDIFF('day', CAST(${l} AS DATE), CAST(${r} AS DATE))) / 365.0)`,
    tokenCosine: (l, r) => tokenCosineSnowflake(l, r),
  };
}

/**
 * BigQuery fuzzy functions.
 *
 * Note: `jaroWinkler` calls the `bms_jaro_winkler` temp SQL UDF — a
 * prefix-boosted EDIT_DISTANCE approximation, since BigQuery has no native
 * Jaro-Winkler (see `BIGQUERY_JARO_WINKLER_UDF`). SQL UDFs are inlined by the
 * query optimizer and run at native speed, unlike the former `LANGUAGE js`
 * implementation whose per-row V8 sandbox made scoring jobs run for minutes
 * on even small candidate-pair tables.
 */
function bigqueryFuzzy(): FuzzyFunctions {
  return {
    jaroWinkler: (l, r) => `bms_jaro_winkler(${l}, ${r})`,
    editDistanceSimilarity: (l, r) =>
      `1.0 - EDIT_DISTANCE(${l}, ${r}) / GREATEST(LENGTH(${l}), LENGTH(${r}), 1)`,
    soundexMatch: (l, r) => `CASE WHEN SOUNDEX(${l}) = SOUNDEX(${r}) THEN 1.0 ELSE 0.0 END`,
    exact: (l, r) => `CASE WHEN ${l} = ${r} THEN 1.0 ELSE 0.0 END`,
    numericDistance: (l, r) =>
      `1.0 - ABS(CAST(${l} AS FLOAT64) - CAST(${r} AS FLOAT64)) / GREATEST(ABS(CAST(${l} AS FLOAT64)), ABS(CAST(${r} AS FLOAT64)), 1.0)`,
    dateProximity: (l, r) =>
      `GREATEST(0.0, 1.0 - ABS(DATE_DIFF(CAST(${l} AS DATE), CAST(${r} AS DATE), DAY)) / 365.0)`,
    tokenCosine: (l, r) => `bms_token_cosine(${l}, ${r})`,
  };
}

/**
 * PostgreSQL fuzzy functions.
 *
 * Requires the `pg_trgm` extension for `similarity()` and the
 * `fuzzystrmatch` extension for `levenshtein()` and `soundex()`.
 * Enable them with:
 *   CREATE EXTENSION IF NOT EXISTS pg_trgm;
 *   CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;
 *
 * Note: `jaroWinkler` uses pg_trgm `similarity()` (trigram-based),
 * which approximates but is not identical to true Jaro-Winkler.
 * PostgreSQL does not provide a native Jaro-Winkler function.
 */
function postgresFuzzy(): FuzzyFunctions {
  return {
    // pg_trgm similarity (trigram-based approximation, not true Jaro-Winkler)
    jaroWinkler: (l, r) => `similarity(${l}, ${r})`,
    editDistanceSimilarity: (l, r) =>
      `1.0 - levenshtein(${l}, ${r})::float / GREATEST(LENGTH(${l}), LENGTH(${r}), 1)`,
    soundexMatch: (l, r) => `CASE WHEN soundex(${l}) = soundex(${r}) THEN 1.0 ELSE 0.0 END`,
    exact: (l, r) => `CASE WHEN ${l} = ${r} THEN 1.0 ELSE 0.0 END`,
    numericDistance: (l, r) =>
      `1.0 - ABS(CAST(${l} AS DOUBLE PRECISION) - CAST(${r} AS DOUBLE PRECISION)) / GREATEST(ABS(CAST(${l} AS DOUBLE PRECISION)), ABS(CAST(${r} AS DOUBLE PRECISION)), 1.0)`,
    dateProximity: (l, r) =>
      `GREATEST(0.0, 1.0 - ABS((CAST(${l} AS DATE) - CAST(${r} AS DATE))::FLOAT) / 365.0)`,
    tokenCosine: (l, r) =>
      tokenCosineFromSetRows(
        l,
        r,
        tokenSetRowsPostgres(l),
        tokenSetRowsPostgres(r),
        'DOUBLE PRECISION'
      ),
  };
}

function duckdbFuzzy(): FuzzyFunctions {
  return {
    jaroWinkler: (l, r) => `jaro_winkler_similarity(${l}, ${r})`,
    editDistanceSimilarity: (l, r) =>
      `1.0 - editdist3(${l}, ${r})::FLOAT / GREATEST(LENGTH(${l}), LENGTH(${r}), 1)`,
    soundexMatch: (l, r) => `CASE WHEN SOUNDEX(${l}) = SOUNDEX(${r}) THEN 1.0 ELSE 0.0 END`,
    exact: (l, r) => `CASE WHEN ${l} = ${r} THEN 1.0 ELSE 0.0 END`,
    numericDistance: (l, r) =>
      `1.0 - ABS(CAST(${l} AS DOUBLE) - CAST(${r} AS DOUBLE)) / GREATEST(ABS(CAST(${l} AS DOUBLE)), ABS(CAST(${r} AS DOUBLE)), 1.0)`,
    dateProximity: (l, r) =>
      `GREATEST(0.0, 1.0 - ABS(DATE_DIFF('day', CAST(${l} AS DATE), CAST(${r} AS DATE))) / 365.0)`,
    tokenCosine: (l, r) =>
      tokenCosineFromSetRows(l, r, tokenSetRowsDuckdb(l), tokenSetRowsDuckdb(r), 'DOUBLE'),
  };
}

/**
 * Databricks fuzzy functions.
 *
 * Note: `jaroWinkler` uses a prefix-boosted Levenshtein approximation
 * because Databricks SQL does not provide a native Jaro-Winkler function.
 */
function databricksFuzzy(): FuzzyFunctions {
  return {
    // Prefix-boosted Levenshtein approximation (not true Jaro-Winkler)
    jaroWinkler: (l, r) => prefixBoostedEditDistanceJw(l, r, 'levenshtein'),
    editDistanceSimilarity: (l, r) =>
      `1.0 - levenshtein(${l}, ${r}) / GREATEST(LENGTH(${l}), LENGTH(${r}), 1)`,
    soundexMatch: (l, r) => `CASE WHEN soundex(${l}) = soundex(${r}) THEN 1.0 ELSE 0.0 END`,
    exact: (l, r) => `CASE WHEN ${l} = ${r} THEN 1.0 ELSE 0.0 END`,
    numericDistance: (l, r) =>
      `1.0 - ABS(CAST(${l} AS DOUBLE) - CAST(${r} AS DOUBLE)) / GREATEST(ABS(CAST(${l} AS DOUBLE)), ABS(CAST(${r} AS DOUBLE)), 1.0)`,
    dateProximity: (l, r) =>
      `GREATEST(0.0, 1.0 - ABS(DATEDIFF(CAST(${l} AS DATE), CAST(${r} AS DATE))) / 365.0)`,
    tokenCosine: (l, r) => tokenCosineSpark(l, r),
  };
}

function mysqlFuzzy(): FuzzyFunctions {
  return {
    jaroWinkler: () => {
      throw unsupportedDialectFeatureError(
        'mysql',
        'fuzzy:jaro_winkler',
        'jaro_winkler is not supported for compiler target "mysql". Use exact or another supported algorithm instead.'
      );
    },
    editDistanceSimilarity: () => {
      throw unsupportedDialectFeatureError(
        'mysql',
        'fuzzy:edit_distance',
        'edit_distance is not supported for compiler target "mysql". Use exact or another supported algorithm instead.'
      );
    },
    soundexMatch: (l, r) => `CASE WHEN SOUNDEX(${l}) = SOUNDEX(${r}) THEN 1.0 ELSE 0.0 END`,
    exact: (l, r) => `CASE WHEN ${l} = ${r} THEN 1.0 ELSE 0.0 END`,
    numericDistance: (l, r) =>
      `1.0 - ABS(CAST(${l} AS DOUBLE) - CAST(${r} AS DOUBLE)) / GREATEST(ABS(CAST(${l} AS DOUBLE)), ABS(CAST(${r} AS DOUBLE)), 1.0)`,
    dateProximity: (l, r) =>
      `GREATEST(0.0, 1.0 - ABS(DATEDIFF(CAST(${l} AS DATE), CAST(${r} AS DATE))) / 365.0)`,
    tokenCosine: () => {
      throw unsupportedDialectFeatureError(
        'mysql',
        'fuzzy:token_cosine',
        'token_cosine is not supported for compiler target "mysql" in v1. Use exact, soundex, numeric_distance, or date_proximity instead.'
      );
    },
  };
}

/**
 * ClickHouse fuzzy functions.
 *
 * ClickHouse ships `editDistance` and `soundex` but has no native
 * Jaro-Winkler, and `ngramDistance` is a character-ngram measure rather than
 * the token-set cosine the planner expects, so both take the unsupported path
 * to match the `false` entries in the ClickHouse dialect profile.
 */
function clickhouseFuzzy(): FuzzyFunctions {
  return {
    jaroWinkler: () => {
      throw unsupportedDialectFeatureError(
        'clickhouse',
        'fuzzy:jaro_winkler',
        'jaro_winkler is not supported for compiler target "clickhouse". Use exact or another supported algorithm instead.'
      );
    },
    // `editDistance` counts bytes, and `length` counts bytes too, so the ratio
    // stays consistent. The character-exact `editDistanceUTF8` only arrived in
    // 24.6 and the compiler cannot see the server version.
    editDistanceSimilarity: (l, r) =>
      `1.0 - editDistance(${l}, ${r}) / greatest(length(${l}), length(${r}), 1)`,
    soundexMatch: (l, r) => `CASE WHEN soundex(${l}) = soundex(${r}) THEN 1.0 ELSE 0.0 END`,
    exact: (l, r) => `CASE WHEN ${l} = ${r} THEN 1.0 ELSE 0.0 END`,
    numericDistance: (l, r) =>
      `1.0 - abs(CAST(${l} AS Float64) - CAST(${r} AS Float64)) / greatest(abs(CAST(${l} AS Float64)), abs(CAST(${r} AS Float64)), 1.0)`,
    dateProximity: (l, r) =>
      `greatest(0.0, 1.0 - abs(dateDiff('day', CAST(${l} AS Date), CAST(${r} AS Date))) / 365.0)`,
    tokenCosine: () => {
      throw unsupportedDialectFeatureError(
        'clickhouse',
        'fuzzy:token_cosine',
        'token_cosine is not supported for compiler target "clickhouse". Use exact, soundex, numeric_distance, or date_proximity instead.'
      );
    },
  };
}

function redshiftFuzzy(): FuzzyFunctions {
  return {
    jaroWinkler: () => {
      throw unsupportedDialectFeatureError(
        'redshift',
        'fuzzy:jaro_winkler',
        'jaro_winkler is not supported for compiler target "redshift". Use exact or another supported algorithm instead.'
      );
    },
    editDistanceSimilarity: () => {
      throw unsupportedDialectFeatureError(
        'redshift',
        'fuzzy:edit_distance',
        'edit_distance is not supported for compiler target "redshift". Use exact or another supported algorithm instead.'
      );
    },
    soundexMatch: (l, r) => `CASE WHEN SOUNDEX(${l}) = SOUNDEX(${r}) THEN 1.0 ELSE 0.0 END`,
    exact: (l, r) => `CASE WHEN ${l} = ${r} THEN 1.0 ELSE 0.0 END`,
    numericDistance: (l, r) =>
      `1.0 - ABS(CAST(${l} AS DOUBLE PRECISION) - CAST(${r} AS DOUBLE PRECISION)) / GREATEST(ABS(CAST(${l} AS DOUBLE PRECISION)), ABS(CAST(${r} AS DOUBLE PRECISION)), 1.0)`,
    dateProximity: (l, r) =>
      `GREATEST(0.0, 1.0 - ABS(DATEDIFF(day, CAST(${l} AS DATE), CAST(${r} AS DATE))) / 365.0)`,
    tokenCosine: (l, r) =>
      tokenCosineFromSetRows(
        l,
        r,
        tokenSetRowsRedshift(l),
        tokenSetRowsRedshift(r),
        'DOUBLE PRECISION'
      ),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Get the fuzzy function implementations for a specific dialect. */
export function getFuzzyFunctions(dialect: SupportedDialect): FuzzyFunctions {
  // Redshift is Postgres-family but has restricted fuzzy support (soundex only,
  // no pg_trgm/fuzzystrmatch extensions), so it needs its own implementation.
  if (dialect === 'redshift') return redshiftFuzzy();

  switch (getCanonicalDialect(dialect)) {
    case 'snowflake':
      return snowflakeFuzzy();
    case 'bigquery':
      return bigqueryFuzzy();
    case 'postgres':
      return postgresFuzzy();
    case 'duckdb':
      return duckdbFuzzy();
    case 'databricks':
      return databricksFuzzy();
    case 'mysql':
      return mysqlFuzzy();
    case 'clickhouse':
      return clickhouseFuzzy();
  }
}

/** List fuzzy/scoring algorithms supported by the resolved dialect target. */
export function getSupportedFuzzyAlgorithms(dialect: SupportedDialect): FuzzyAlgorithm[] {
  return FUZZY_ALGORITHMS.filter((algorithm) => {
    if (
      algorithm === 'jaro_winkler' ||
      algorithm === 'edit_distance' ||
      algorithm === 'soundex' ||
      algorithm === 'token_cosine'
    ) {
      return supportsFuzzyAlgorithm(dialect, algorithm);
    }
    return true;
  });
}

/** Get the SQL expression for a fuzzy match given algorithm, dialect, and column refs. */
export function fuzzyScoreExpr(
  algorithm: FuzzyAlgorithm,
  leftCol: string,
  rightCol: string,
  dialect: SupportedDialect
): string {
  if (
    (algorithm === 'jaro_winkler' ||
      algorithm === 'edit_distance' ||
      algorithm === 'soundex' ||
      algorithm === 'token_cosine') &&
    !supportsFuzzyAlgorithm(dialect, algorithm)
  ) {
    throw unsupportedDialectFeatureError(
      dialect,
      `fuzzy:${algorithm}`,
      `${algorithm} is not supported for compiler target "${dialect}". Use exact or another supported algorithm instead.`
    );
  }

  const fns = getFuzzyFunctions(dialect);
  switch (algorithm) {
    case 'jaro_winkler':
      return fns.jaroWinkler(leftCol, rightCol);
    case 'edit_distance':
      return fns.editDistanceSimilarity(leftCol, rightCol);
    case 'soundex':
      return fns.soundexMatch(leftCol, rightCol);
    case 'exact':
      return fns.exact(leftCol, rightCol);
    case 'numeric_distance':
      return fns.numericDistance(leftCol, rightCol);
    case 'date_proximity':
      return fns.dateProximity(leftCol, rightCol);
    case 'token_cosine':
      return fns.tokenCosine(leftCol, rightCol);
  }
}

/** Human-facing notes for approximate or dialect-limited fuzzy algorithms. */
export function getFuzzyAlgorithmNotes(dialect: SupportedDialect): string[] {
  const notes = ['token_cosine uses deduplicated whitespace token sets: |A∩B| / sqrt(|A| * |B|).'];

  switch (dialect) {
    case 'bigquery':
      notes.push(
        'bigquery jaro_winkler uses a native SQL bms_jaro_winkler temp UDF with prefix-boosted EDIT_DISTANCE; it is approximate, not true Jaro-Winkler.',
        'bigquery token_cosine uses a native SQL bms_token_cosine temp UDF over UNNESTed token sets.'
      );
      break;
    case 'postgres':
    case 'pgvector':
      notes.push(
        `${dialect} jaro_winkler uses pg_trgm similarity(), which is trigram-based and approximate.`
      );
      break;
    case 'databricks':
      notes.push(
        'databricks jaro_winkler uses a prefix-boosted levenshtein approximation because Databricks SQL has no native Jaro-Winkler.'
      );
      break;
    case 'mysql':
      notes.push(
        'mysql supports exact, soundex, numeric_distance, and date_proximity; jaro_winkler, edit_distance, and token_cosine are unsupported in v1.'
      );
      break;
    case 'redshift':
      notes.push(
        'redshift supports token_cosine with SPLIT_TO_ARRAY plus set intersection; jaro_winkler and edit_distance remain unsupported in v1.'
      );
      break;
    case 'clickhouse':
      notes.push(
        'clickhouse supports exact, edit_distance, soundex, numeric_distance, and date_proximity; jaro_winkler and token_cosine are unsupported.',
        'clickhouse edit_distance is byte-based, so it over-counts differences in multi-byte characters.'
      );
      break;
    default:
      break;
  }

  return notes;
}

/**
 * BigQuery Jaro-Winkler UDF DDL.
 *
 * A native SQL UDF (not `LANGUAGE js`): the body is macro-inlined by the
 * query optimizer and EDIT_DISTANCE runs in-engine, so it scores millions of
 * pairs in seconds. The previous JS implementation routed every row through a
 * sandboxed V8 process and took minutes on a few hundred thousand pairs.
 *
 * It approximates Jaro-Winkler as Winkler's prefix adjustment applied to
 * normalized edit-distance similarity: `sim + p * 0.1 * (1 - sim)` where
 * `sim = 1 - EDIT_DISTANCE / max(len)` and `p` is the common-prefix length
 * capped at 4. Not bit-identical to true Jaro-Winkler (transposition handling
 * differs), but preserves its key ranking properties: prefix-heavy matches
 * score high, and scores stay in [0, 1] with 1.0 only for equal strings.
 *
 * Emitted as a `CREATE TEMP FUNCTION` so it can be prepended to (inlined into)
 * each statement that calls `bms_jaro_winkler(...)`. BigQuery temp functions are
 * job-scoped, so a standalone preamble job is both unexecutable (a job with only
 * a temp-function DDL and no query is rejected) and useless (a separate scoring
 * job would not see it). Keeping the trailing `;` lets it be concatenated ahead
 * of a following statement to form a valid multi-statement script job.
 */
export const BIGQUERY_JARO_WINKLER_UDF = `CREATE TEMP FUNCTION bms_jaro_winkler(s1 STRING, s2 STRING)
RETURNS FLOAT64
AS (
  CASE
    WHEN s1 IS NULL OR s2 IS NULL OR LENGTH(s1) = 0 OR LENGTH(s2) = 0 THEN 0.0
    WHEN s1 = s2 THEN 1.0
    ELSE
      (1.0 - EDIT_DISTANCE(s1, s2) / GREATEST(LENGTH(s1), LENGTH(s2), 1))
      + CASE
          WHEN SUBSTR(s1, 1, 4) = SUBSTR(s2, 1, 4) THEN 4
          WHEN SUBSTR(s1, 1, 3) = SUBSTR(s2, 1, 3) THEN 3
          WHEN SUBSTR(s1, 1, 2) = SUBSTR(s2, 1, 2) THEN 2
          WHEN SUBSTR(s1, 1, 1) = SUBSTR(s2, 1, 1) THEN 1
          ELSE 0
        END * 0.1 * (EDIT_DISTANCE(s1, s2) / GREATEST(LENGTH(s1), LENGTH(s2), 1))
  END
);`;

/**
 * BigQuery token cosine UDF DDL.
 *
 * Computes the Phase 2 AWS-parity token-set cosine exactly: split normalized
 * whitespace-delimited tokens, dedupe each side, count the intersection, and
 * divide by the geometric mean of the token-set sizes. Kept as a native SQL UDF
 * so it is optimizer-visible and can be prepended to each consuming statement.
 */
export const BIGQUERY_TOKEN_COSINE_UDF = `CREATE TEMP FUNCTION bms_token_cosine(s1 STRING, s2 STRING)
RETURNS FLOAT64
AS ((
  WITH
    left_tokens AS (
      SELECT DISTINCT token
      FROM UNNEST(SPLIT(REGEXP_REPLACE(TRIM(IFNULL(s1, '')), r'\\s+', ' '), ' ')) AS token
      WHERE token != ''
    ),
    right_tokens AS (
      SELECT DISTINCT token
      FROM UNNEST(SPLIT(REGEXP_REPLACE(TRIM(IFNULL(s2, '')), r'\\s+', ' '), ' ')) AS token
      WHERE token != ''
    ),
    counts AS (
      SELECT
        (SELECT COUNT(*) FROM left_tokens) AS left_count,
        (SELECT COUNT(*) FROM right_tokens) AS right_count,
        (
          SELECT COUNT(*)
          FROM left_tokens
          INNER JOIN right_tokens USING (token)
        ) AS intersection_count
    )
  SELECT
    IF(
      left_count = 0 OR right_count = 0,
      0.0,
      LEAST(1.0, GREATEST(0.0, intersection_count / SQRT(left_count * right_count)))
    )
  FROM counts
));`;

/**
 * Generate dialect-specific fuzzy function preamble SQL.
 *
 * - Postgres: pg_trgm + fuzzystrmatch extensions (database-level, persistent —
 *   a valid standalone preamble).
 * - BigQuery: empty string. Fuzzy UDFs are job-scoped temp functions, so they
 *   cannot be emitted as a standalone preamble; they are inlined into each
 *   consuming statement instead (see `inlineFuzzyUdf`).
 * - Other dialects: empty string (no preamble needed).
 */
export function generateFuzzyPreamble(dialect: SupportedDialect): string {
  if (dialect === 'redshift') {
    return '';
  }
  if (getCanonicalDialect(dialect) === 'postgres') {
    return `CREATE EXTENSION IF NOT EXISTS pg_trgm;\nCREATE EXTENSION IF NOT EXISTS fuzzystrmatch;`;
  }
  return '';
}

/**
 * Prepend BigQuery fuzzy UDFs to a statement that calls them.
 *
 * Only applies when the canonical dialect is BigQuery and the SQL actually
 * references a `bms_*` fuzzy UDF. Idempotent: a statement already prefixed with
 * the needed UDF DDL is returned unchanged.
 */
export function prependFuzzyUdfIfNeeded(sql: string, dialect: CanonicalDialect): string {
  if (dialect !== 'bigquery') return sql;

  const preambles: string[] = [];
  if (sql.includes('bms_jaro_winkler(') && !sql.includes('CREATE TEMP FUNCTION bms_jaro_winkler')) {
    preambles.push(BIGQUERY_JARO_WINKLER_UDF);
  }
  if (sql.includes('bms_token_cosine(') && !sql.includes('CREATE TEMP FUNCTION bms_token_cosine')) {
    preambles.push(BIGQUERY_TOKEN_COSINE_UDF);
  }

  if (preambles.length === 0) return sql;
  return `${preambles.join('\n')}\n${sql}`;
}

/**
 * Inline BigQuery fuzzy UDFs into every statement that calls them.
 *
 * Maps over the statements, prepending UDF DDL to each statement whose SQL
 * references `bms_*` fuzzy calls (BigQuery only). A no-op for every other dialect
 * and for statements that do not use the UDF.
 */
export function inlineFuzzyUdf<T extends { sql: string }>(
  statements: T[],
  dialect: CanonicalDialect
): T[] {
  return statements.map((statement) => ({
    ...statement,
    sql: prependFuzzyUdfIfNeeded(statement.sql, dialect),
  }));
}
