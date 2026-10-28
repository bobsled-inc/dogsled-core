/**
 * Cleaning function definitions for the cross-dialect SQL catalog.
 *
 * These functions compile to dialect-specific REGEXP_REPLACE / CAST expressions,
 * giving models a vocabulary of named cleaning primitives that the profiler and
 * agents can suggest by name instead of hand-rolling raw SQL.
 */

import { getCanonicalDialect, quoteLiteral } from '../dialect.js';
import type { SupportedDialect } from '../dialect.js';
import {
  USPS_DIRECTIONALS,
  USPS_SECONDARY_UNIT_DESIGNATORS,
  USPS_STREET_SUFFIXES,
} from './address-normalization-data.js';
import { CommandError } from '../../errors.js';
import type { FunctionDef } from './functions.js';

const ACCENTED_CHARS =
  'ÀÁÂÃÄÅĀĂĄÇĆĈĊČÐĎĐÈÉÊËĒĔĖĘĚÌÍÎÏĨĪĬĮİÑŃŅŇÒÓÔÕÖØŌŎŐÙÚÛÜŨŪŬŮŰŲÝŸŶŹŻŽàáâãäåāăąçćĉċčðďđèéêëēĕėęěìíîïĩīĭįıñńņňòóôõöøōŏőùúûüũūŭůűųýÿŷźżžßÆæŒœ';
const ASCII_CHARS =
  'AAAAAAAAACCCCCDDDEEEEEEEEEIIIIIIIIINNNOOOOOOOOOUUUUUUUUUUUYYYZZZaaaaaaaaacccccdddeeeeeeeeeiiiiiiiiinnnooooooooouuuuuuuuuuuyyyzzzsAaOo';

// TRANSLATE requires equal-length source and replacement strings
if ([...ACCENTED_CHARS].length !== [...ASCII_CHARS].length) {
  throw new Error(
    `ACCENTED_CHARS (${[...ACCENTED_CHARS].length}) and ASCII_CHARS (${[...ASCII_CHARS].length}) must have equal codepoint length`
  );
}

const US_STATES = [
  ['AL', 'Alabama'],
  ['AK', 'Alaska'],
  ['AZ', 'Arizona'],
  ['AR', 'Arkansas'],
  ['CA', 'California'],
  ['CO', 'Colorado'],
  ['CT', 'Connecticut'],
  ['DE', 'Delaware'],
  ['DC', 'District of Columbia'],
  ['FL', 'Florida'],
  ['GA', 'Georgia'],
  ['HI', 'Hawaii'],
  ['ID', 'Idaho'],
  ['IL', 'Illinois'],
  ['IN', 'Indiana'],
  ['IA', 'Iowa'],
  ['KS', 'Kansas'],
  ['KY', 'Kentucky'],
  ['LA', 'Louisiana'],
  ['ME', 'Maine'],
  ['MD', 'Maryland'],
  ['MA', 'Massachusetts'],
  ['MI', 'Michigan'],
  ['MN', 'Minnesota'],
  ['MS', 'Mississippi'],
  ['MO', 'Missouri'],
  ['MT', 'Montana'],
  ['NE', 'Nebraska'],
  ['NV', 'Nevada'],
  ['NH', 'New Hampshire'],
  ['NJ', 'New Jersey'],
  ['NM', 'New Mexico'],
  ['NY', 'New York'],
  ['NC', 'North Carolina'],
  ['ND', 'North Dakota'],
  ['OH', 'Ohio'],
  ['OK', 'Oklahoma'],
  ['OR', 'Oregon'],
  ['PA', 'Pennsylvania'],
  ['RI', 'Rhode Island'],
  ['SC', 'South Carolina'],
  ['SD', 'South Dakota'],
  ['TN', 'Tennessee'],
  ['TX', 'Texas'],
  ['UT', 'Utah'],
  ['VT', 'Vermont'],
  ['VA', 'Virginia'],
  ['WA', 'Washington'],
  ['WV', 'West Virginia'],
  ['WI', 'Wisconsin'],
  ['WY', 'Wyoming'],
] as const;

const LEGAL_SUFFIX_PATTERN =
  '(?:^|\\s+|,\\s*)(inc\\.?|incorporated|llc\\.?|l\\.l\\.c\\.?|ltd\\.?|limited|corp\\.?|corporation|company|co\\.?)$';

type EmitFn = (args: string[], dialect: SupportedDialect) => string;

function stripQuotes(s: string): string {
  return s.startsWith("'") && s.endsWith("'") ? s.slice(1, -1).replace(/''/g, "'") : s;
}

function regexpReplace(
  expr: string,
  pattern: string,
  replacement: string,
  flags: { global?: boolean; caseInsensitive?: boolean },
  dialect: SupportedDialect
): string {
  const canonical = getCanonicalDialect(dialect);
  const { global: isGlobal = false, caseInsensitive = false } = flags;
  const patternForDialect =
    caseInsensitive &&
    (canonical === 'bigquery' || canonical === 'databricks' || canonical === 'clickhouse')
      ? `(?i)${pattern}`
      : pattern;
  const patternLiteral = quoteLiteral(patternForDialect, dialect);
  const replacementLiteral = quoteLiteral(replacement, dialect);

  switch (canonical) {
    case 'bigquery':
    case 'databricks':
      return `REGEXP_REPLACE(${expr}, ${patternLiteral}, ${replacementLiteral})`;
    case 'snowflake':
    case 'mysql': {
      const matchParam = caseInsensitive ? `, ${quoteLiteral('i', dialect)}` : '';
      const occurrence = isGlobal ? '0' : '1';
      return `REGEXP_REPLACE(${expr}, ${patternLiteral}, ${replacementLiteral}, 1, ${occurrence}${matchParam})`;
    }
    case 'postgres': {
      if (dialect === 'redshift') {
        return caseInsensitive
          ? `REGEXP_REPLACE(${expr}, ${patternLiteral}, ${replacementLiteral}, 1, ${quoteLiteral('i', dialect)})`
          : `REGEXP_REPLACE(${expr}, ${patternLiteral}, ${replacementLiteral})`;
      }
      const pgFlags = `${isGlobal ? 'g' : ''}${caseInsensitive ? 'i' : ''}`;
      return pgFlags
        ? `regexp_replace(${expr}, ${patternLiteral}, ${replacementLiteral}, ${quoteLiteral(pgFlags, dialect)})`
        : `regexp_replace(${expr}, ${patternLiteral}, ${replacementLiteral})`;
    }
    case 'duckdb': {
      const flags = `${isGlobal ? 'g' : ''}${caseInsensitive ? 'i' : ''}`;
      return flags
        ? `regexp_replace(${expr}, ${patternLiteral}, ${replacementLiteral}, ${quoteLiteral(flags, dialect)})`
        : `regexp_replace(${expr}, ${patternLiteral}, ${replacementLiteral})`;
    }
    case 'clickhouse':
      return isGlobal
        ? `replaceRegexpAll(${expr}, ${patternLiteral}, ${replacementLiteral})`
        : `replaceRegexpOne(${expr}, ${patternLiteral}, ${replacementLiteral})`;
  }
}

function allDialects(fn: EmitFn): FunctionDef['emit'] {
  return {
    snowflake: fn,
    bigquery: fn,
    databricks: fn,
    postgres: fn,
    duckdb: fn,
    mysql: fn,
    clickhouse: fn,
  };
}

function allDialectsRegexp(
  pattern: string,
  replacement: string,
  flags: { global?: boolean; caseInsensitive?: boolean }
): FunctionDef['emit'] {
  return allDialects((args, d) => regexpReplace(args[0]!, pattern, replacement, flags, d));
}

function regexpLike(expr: string, pattern: string, dialect: SupportedDialect): string {
  const patternLiteral = quoteLiteral(pattern, dialect);
  switch (getCanonicalDialect(dialect)) {
    case 'bigquery':
      return `REGEXP_CONTAINS(${expr}, ${patternLiteral})`;
    case 'duckdb':
      return `regexp_matches(${expr}, ${patternLiteral})`;
    case 'postgres':
      return `${expr} ~ ${patternLiteral}`;
    case 'snowflake':
    case 'databricks':
    case 'mysql':
      return `REGEXP_LIKE(${expr}, ${patternLiteral})`;
    case 'clickhouse':
      return `match(${expr}, ${patternLiteral})`;
  }
}

function stripCountryCode(expr: string, dialect: SupportedDialect): string {
  switch (getCanonicalDialect(dialect)) {
    case 'postgres':
    case 'duckdb':
      return `CASE WHEN length(${expr}) = 11 AND left(${expr}, 1) = '1' THEN substr(${expr}, 2) ELSE ${expr} END`;
    case 'mysql':
      return `CASE WHEN LENGTH(${expr}) = 11 AND LEFT(${expr}, 1) = '1' THEN SUBSTRING(${expr}, 2) ELSE ${expr} END`;
    default:
      return `CASE WHEN LENGTH(${expr}) = 11 AND LEFT(${expr}, 1) = '1' THEN SUBSTR(${expr}, 2) ELSE ${expr} END`;
  }
}

function stripAccents(expr: string, dialect: SupportedDialect): string {
  switch (getCanonicalDialect(dialect)) {
    case 'duckdb':
      return `TRANSLATE(strip_accents(${expr}), 'ÆæŒœ', 'AaOo')`;
    case 'postgres':
      return `unaccent(${expr})`;
    case 'bigquery':
      return `REGEXP_REPLACE(NORMALIZE(${expr}, NFD), r'\\pM', '')`;
    case 'mysql':
      return `CONVERT(${expr} USING ASCII)`;
    case 'snowflake':
    case 'databricks':
      return `TRANSLATE(${expr}, ${quoteLiteral(ACCENTED_CHARS, dialect)}, ${quoteLiteral(ASCII_CHARS, dialect)})`;
    case 'clickhouse':
      // ClickHouse's byte-oriented `translate` rejects multi-byte arguments, so
      // the UTF-8 variant carries the table Snowflake and Databricks also use.
      return `translateUTF8(${expr}, ${quoteLiteral(ACCENTED_CHARS, dialect)}, ${quoteLiteral(ASCII_CHARS, dialect)})`;
  }
}

function normalizeState(expr: string, dialect: SupportedDialect): string {
  const normalized = `UPPER(TRIM(${expr}))`;
  const cases = US_STATES.flatMap(([code, name]) => [
    `WHEN ${quoteLiteral(code, dialect)} THEN ${quoteLiteral(code, dialect)}`,
    `WHEN ${quoteLiteral(name.toUpperCase(), dialect)} THEN ${quoteLiteral(code, dialect)}`,
  ]).join(' ');
  return `CASE ${normalized} ${cases} ELSE ${normalized} END`;
}

function tokenVariantPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
}

// PostgreSQL's advanced regular expressions treat `\b` as the BACKSPACE
// character-entry escape, NOT a word boundary — so `\b(?:st|ave)\b` never
// matches and every address token replacement is a silent no-op on Postgres.
// Postgres (and pgvector, which shares its engine) use `\y`. Redshift, Snowflake,
// DuckDB (RE2), BigQuery (RE2), Databricks (RE2), and MySQL 8 (ICU) all accept `\b`.
function wordBoundaryToken(dialect: SupportedDialect): string {
  return dialect === 'postgres' || dialect === 'pgvector' ? '\\y' : '\\b';
}

function applyAddressTokenMap(expr: string, dialect: SupportedDialect): string {
  const groups = Object.entries({
    ...USPS_STREET_SUFFIXES,
    ...USPS_SECONDARY_UNIT_DESIGNATORS,
    ...USPS_DIRECTIONALS,
  } as Record<string, readonly string[]>)
    .map(([canonical, variants]) => {
      const allVariants = Array.from(new Set([canonical, ...variants]));
      return {
        canonical,
        variants: allVariants,
        maxLength: Math.max(...allVariants.map((v) => v.length)),
      };
    })
    .sort((a, b) => b.maxLength - a.maxLength || b.canonical.length - a.canonical.length);
  const boundary = wordBoundaryToken(dialect);
  let result = expr;
  for (const group of groups) {
    const pattern = `${boundary}(?:${group.variants.map(tokenVariantPattern).join('|')})${boundary}`;
    result = regexpReplace(
      result,
      pattern,
      group.canonical,
      {
        global: true,
        caseInsensitive: true,
      },
      dialect
    );
  }
  return result;
}

function normalizeStreet(expr: string, dialect: SupportedDialect): string {
  const lower = `LOWER(TRIM(${expr}))`;
  const withoutPunctuation = regexpReplace(lower, '[^a-zA-Z0-9 ]', ' ', { global: true }, dialect);
  const collapsed = regexpReplace(withoutPunctuation, '\\s+', ' ', { global: true }, dialect);
  return `TRIM(${applyAddressTokenMap(collapsed, dialect)})`;
}

function normalizePostal(expr: string, dialect: SupportedDialect): string {
  const normalized = `UPPER(TRIM(${expr}))`;
  const digits = regexpReplace(normalized, '[^0-9]', '', { global: true }, dialect);
  const compact = regexpReplace(normalized, '[\\s-]+', '', { global: true }, dialect);
  const zipPlusFour = regexpLike(normalized, '^[0-9]{5}-?[0-9]{4}$', dialect);
  return `CASE WHEN ${expr} IS NULL THEN NULL WHEN ${zipPlusFour} THEN SUBSTR(${digits}, 1, 5) ELSE ${compact} END`;
}

function extractEmailDomain(expr: string, dialect: SupportedDialect): string {
  switch (getCanonicalDialect(dialect)) {
    case 'snowflake':
      return `SPLIT_PART(${expr}, '@', 2)`;
    case 'bigquery':
      return `SPLIT(${expr}, '@')[SAFE_OFFSET(1)]`;
    case 'databricks':
      return `SPLIT(${expr}, '@')[1]`;
    case 'mysql':
      return `SUBSTRING_INDEX(${expr}, '@', -1)`;
    case 'postgres':
    case 'duckdb':
      return `split_part(${expr}, '@', 2)`;
    case 'clickhouse':
      // ClickHouse cannot put an Array inside Nullable, so splitByChar fails on a
      // nullable email column; an RE2 capture group returns '' the way split_part does.
      return `extract(${expr}, '@([^@]*)$')`;
  }
}

function extractDomain(expr: string, dialect: SupportedDialect): string {
  const withoutProtocol = regexpReplace(
    expr,
    '^(?:https?://)?(?:www\\.)?',
    '',
    { caseInsensitive: true },
    dialect
  );
  return regexpReplace(withoutProtocol, '[/?#].*$', '', {}, dialect);
}

function normalizePhone(expr: string, dialect: SupportedDialect): string {
  return stripCountryCode(regexpReplace(expr, '[^0-9]', '', { global: true }, dialect), dialect);
}

function normalizeCompany(expr: string, dialect: SupportedDialect): string {
  const trimmed = `TRIM(${expr})`;
  const stripped = regexpReplace(
    trimmed,
    LEGAL_SUFFIX_PATTERN,
    '',
    { caseInsensitive: true },
    dialect
  );
  return regexpReplace(`LOWER(${stripped})`, '\\s+', ' ', { global: true }, dialect);
}

function normalizeEmailUid2(expr: string, dialect: SupportedDialect): string {
  const normalized = `LOWER(TRIM(${expr}))`;
  const localPart = emailLocalPart(normalized, dialect);
  const domain = emailDomainPart(normalized, dialect);
  const withoutSubaddress = regexpReplace(localPart, '\\+.*$', '', {}, dialect);
  const gmailLocal = regexpReplace(withoutSubaddress, '\\.', '', { global: true }, dialect);
  return [
    `CASE`,
    `  WHEN ${expr} IS NULL THEN NULL`,
    `  WHEN ${domain} = ${quoteLiteral('', dialect)} THEN ${normalized}`,
    `  WHEN ${domain} IN (${quoteLiteral('gmail.com', dialect)}, ${quoteLiteral('googlemail.com', dialect)}) THEN ${concatExpr([gmailLocal, quoteLiteral('@gmail.com', dialect)], dialect)}`,
    `  ELSE ${normalized}`,
    `END`,
  ].join(' ');
}

function emailLocalPart(expr: string, dialect: SupportedDialect): string {
  switch (getCanonicalDialect(dialect)) {
    case 'snowflake':
      return `SPLIT_PART(${expr}, '@', 1)`;
    case 'bigquery':
      return `SPLIT(${expr}, '@')[SAFE_OFFSET(0)]`;
    case 'databricks':
      return `SPLIT(${expr}, '@')[0]`;
    case 'mysql':
      return `SUBSTRING_INDEX(${expr}, '@', 1)`;
    case 'postgres':
    case 'duckdb':
      return `split_part(${expr}, '@', 1)`;
    case 'clickhouse':
      return `extract(${expr}, '^([^@]*)')`;
  }
}

function emailDomainPart(expr: string, dialect: SupportedDialect): string {
  return extractEmailDomain(expr, dialect);
}

function concatExpr(parts: string[], _dialect: SupportedDialect): string {
  return `CONCAT(${parts.join(', ')})`;
}

function castToString(expr: string, dialect: SupportedDialect): string {
  if (dialect === 'redshift') {
    return `CAST(${expr} AS VARCHAR)`;
  }
  switch (getCanonicalDialect(dialect)) {
    case 'bigquery':
    case 'databricks':
      return `CAST(${expr} AS STRING)`;
    case 'mysql':
      return `CAST(${expr} AS CHAR)`;
    case 'postgres':
      return `CAST(${expr} AS TEXT)`;
    case 'duckdb':
    case 'snowflake':
      return `CAST(${expr} AS VARCHAR)`;
    case 'clickhouse':
      // CAST(NULL AS String) raises in ClickHouse; toString propagates NULL.
      return `toString(${expr})`;
  }
}

export function emitSha256Expr(expr: string, dialect: SupportedDialect): string {
  const casted = castToString(expr, dialect);
  if (dialect === 'redshift') {
    return `SHA2(${casted}, 256)`;
  }
  switch (getCanonicalDialect(dialect)) {
    case 'duckdb':
      return `sha256(${casted})`;
    case 'snowflake':
      return `SHA2(${casted}, 256)`;
    case 'bigquery':
      return `TO_HEX(SHA256(${casted}))`;
    case 'postgres':
      return `encode(digest(${casted}, ${quoteLiteral('sha256', dialect)}), ${quoteLiteral('hex', dialect)})`;
    case 'databricks':
      return `sha2(${casted}, 256)`;
    case 'mysql':
      return `SHA2(${casted}, 256)`;
    case 'clickhouse':
      // SHA256 returns raw bytes and hex() uppercases them, so the digest is
      // lowered to stay byte-identical to the other dialects' hex output.
      return `lower(hex(SHA256(${casted})))`;
  }
}

export function readMatchKeySecret(): string {
  const secret = process.env.DOGSLED_MATCH_KEY_SECRET;
  if (!secret) {
    throw new CommandError(
      'DOGSLED_MATCH_KEY_SECRET is required when hmac_sha256 standardize transforms are used.',
      2
    );
  }
  return secret;
}

export const MATCH_KEY_SECRET_RUNTIME_TOKEN = '__DOGSLED_RUNTIME_SECRET_DOGSLED_MATCH_KEY_SECRET__';

export function materializeMatchKeySecretPlaceholders(
  sql: string,
  dialect: SupportedDialect
): string {
  if (!sql.includes(MATCH_KEY_SECRET_RUNTIME_TOKEN)) return sql;
  return sql
    .split(quoteLiteral(MATCH_KEY_SECRET_RUNTIME_TOKEN, dialect))
    .join(quoteLiteral(readMatchKeySecret(), dialect));
}

/**
 * Scrub the materialized match-key secret out of a message before it is logged
 * or surfaced. After `materializeMatchKeySecretPlaceholders` the secret is a
 * plaintext SQL literal, so a driver that echoes the failing statement in its
 * error would otherwise leak `DOGSLED_MATCH_KEY_SECRET` into stderr / CI logs.
 * No-op when the secret is unset (nothing to redact).
 */
export function redactMatchKeySecret(message: string): string {
  const secret = process.env.DOGSLED_MATCH_KEY_SECRET;
  if (!secret || !message.includes(secret)) return message;
  return message.split(secret).join('***');
}

function keyedDoubleSha256(expr: string, dialect: SupportedDialect): string {
  readMatchKeySecret();
  const key = quoteLiteral(MATCH_KEY_SECRET_RUNTIME_TOKEN, dialect);
  // Portable match-key construction, not RFC-2104 HMAC. Every party joining
  // across warehouses must compute this same nested keyed double-hash.
  return `CASE WHEN ${expr} IS NULL THEN NULL ELSE ${emitSha256Expr(
    concatExpr([key, emitSha256Expr(concatExpr([key, expr], dialect), dialect)], dialect),
    dialect
  )} END`;
}

function parseNumber(expr: string, dialect: SupportedDialect): string {
  return safeCast(
    regexpReplace(expr, '[$,\\s]', '', { global: true }, dialect),
    numericType(dialect),
    dialect
  );
}

function fingerprint(expr: string, dialect: SupportedDialect): string {
  const cleaned = regexpReplace(
    regexpReplace(
      `LOWER(TRIM(${stripAccents(expr, dialect)}))`,
      '[^a-zA-Z0-9 ]',
      '',
      { global: true },
      dialect
    ),
    '\\s+',
    ' ',
    { global: true },
    dialect
  );
  switch (getCanonicalDialect(dialect)) {
    case 'snowflake':
      return `ARRAY_TO_STRING(ARRAY_SORT(ARRAY_DISTINCT(SPLIT(${cleaned}, ' '))), ' ')`;
    case 'bigquery':
      return `ARRAY_TO_STRING(ARRAY(SELECT DISTINCT token FROM UNNEST(SPLIT(${cleaned}, ' ')) AS token WHERE token != '' ORDER BY token), ' ')`;
    case 'postgres':
      return `array_to_string(ARRAY(SELECT DISTINCT token FROM unnest(string_to_array(${cleaned}, ' ')) AS token WHERE token != '' ORDER BY token), ' ')`;
    case 'duckdb':
      return `array_to_string(list_sort(list_distinct(string_split(${cleaned}, ' '))), ' ')`;
    case 'databricks':
      return `CONCAT_WS(' ', SORT_ARRAY(ARRAY_DISTINCT(FILTER(SPLIT(${cleaned}, ' '), token -> token != ''))))`;
    case 'mysql':
      return cleaned;
    case 'clickhouse':
      // Nullable(Array) does not exist in ClickHouse, so the token list is built
      // from a non-null string; NULL collapses to '' exactly as it does on Postgres.
      return `arrayStringConcat(arraySort(arrayDistinct(arrayFilter(token -> token != '', splitByChar(' ', ifNull(${cleaned}, ''))))), ' ')`;
  }
}

export const CLEANING_FUNCTIONS: FunctionDef[] = [
  {
    name: 'collapse_whitespace',
    minArgs: 1,
    maxArgs: 1,
    category: 'string',
    description: 'Collapse consecutive whitespace characters into a single space.',
    examples: ['collapse_whitespace(company_name)'],
    emit: allDialectsRegexp('\\s+', ' ', { global: true }),
  },
  {
    name: 'nullif_empty',
    minArgs: 1,
    maxArgs: 1,
    category: 'string',
    description: 'Trim a string and convert empty results to NULL.',
    examples: ['nullif_empty(address_line_2)'],
    emit: allDialects((args) => `NULLIF(TRIM(${args[0]!}), '')`),
  },
  {
    name: 'normalize_email',
    minArgs: 1,
    maxArgs: 1,
    category: 'string',
    description: 'Normalize email casing and surrounding whitespace.',
    examples: ['normalize_email(email)'],
    emit: allDialects((args) => `LOWER(TRIM(${args[0]!}))`),
  },
  {
    name: 'normalize_email_uid2',
    minArgs: 1,
    maxArgs: 1,
    category: 'string',
    description: 'Normalize email values using UID2-compatible Gmail dot and plus handling.',
    examples: ['normalize_email_uid2(email)'],
    emit: allDialects((args, d) => normalizeEmailUid2(args[0]!, d)),
  },
  {
    name: 'extract_email_domain',
    minArgs: 1,
    maxArgs: 1,
    category: 'string',
    description: 'Extract the domain part from an email address.',
    examples: ['extract_email_domain(email)'],
    emit: allDialects((args, d) => extractEmailDomain(args[0]!, d)),
  },
  {
    name: 'strip_email_subaddress',
    minArgs: 1,
    maxArgs: 1,
    category: 'string',
    description: 'Remove plus-addressing from email usernames.',
    examples: ['strip_email_subaddress(email)'],
    // `[^@]*` already stops at `@`, so the trailing `(?=@)` lookahead is
    // redundant for real email input (`user+tag@x` → `user@x`) but is rejected
    // by RE2 engines (BigQuery / Databricks / DuckDB) with "invalid perl
    // operator: (?=". Drop it so the pattern is RE2-safe and identical across
    // all six dialects. See `strip_email_subaddress` cleaning tests.
    emit: allDialectsRegexp('\\+[^@]*', '', { global: true }),
  },
  {
    name: 'strip_accents',
    minArgs: 1,
    maxArgs: 1,
    category: 'string',
    description: 'Remove common accents and diacritical marks from a string.',
    examples: ['strip_accents(customer_name)'],
    emit: allDialects((args, d) => stripAccents(args[0]!, d)),
  },
  {
    name: 'strip_legal_suffixes',
    minArgs: 1,
    maxArgs: 1,
    category: 'string',
    description: 'Remove common legal entity suffixes from the end of a string.',
    examples: ['strip_legal_suffixes(company_name)'],
    emit: allDialectsRegexp(LEGAL_SUFFIX_PATTERN, '', { caseInsensitive: true }),
  },
  {
    name: 'strip_trading_as',
    minArgs: 1,
    maxArgs: 1,
    category: 'string',
    description: 'Remove trading-as markers such as d/b/a, dba, trading as, and t/a.',
    examples: ['strip_trading_as(company_name)'],
    emit: allDialectsRegexp(
      '\\s+(?:d\\s*/\\s*b\\s*/\\s*a|dba|trading\\s+as|t\\s*/\\s*a)\\s+.*$',
      '',
      {
        caseInsensitive: true,
      }
    ),
  },
  {
    name: 'strip_www',
    minArgs: 1,
    maxArgs: 1,
    category: 'string',
    description: 'Remove http://, https://, and www. prefixes from URL or domain strings.',
    examples: ['strip_www(website)'],
    emit: allDialectsRegexp('^(?:https?://(?:www\\.)?|www\\.)', '', { caseInsensitive: true }),
  },
  {
    name: 'extract_domain',
    minArgs: 1,
    maxArgs: 1,
    category: 'string',
    description:
      'Extract a host/domain from a URL by removing protocol, www, path, query, and fragment.',
    examples: ['extract_domain(website_url)'],
    emit: allDialects((args, d) => extractDomain(args[0]!, d)),
  },
  {
    name: 'digits_only',
    minArgs: 1,
    maxArgs: 1,
    category: 'string',
    description: 'Remove all non-digit characters, leaving only 0–9.',
    examples: ['digits_only(phone)'],
    emit: allDialectsRegexp('[^0-9]', '', { global: true }),
  },
  {
    name: 'strip_country_code',
    minArgs: 1,
    maxArgs: 1,
    category: 'string',
    description:
      'Remove a leading US/Canada country code from an 11-digit digit-only phone string.',
    examples: ['strip_country_code(digits_only(phone))'],
    emit: allDialects((args, d) => stripCountryCode(args[0]!, d)),
  },
  {
    name: 'strip_phone_extension',
    minArgs: 1,
    maxArgs: 1,
    category: 'string',
    description: 'Remove phone extension suffixes such as ext 123, extension 123, and x123.',
    examples: ['strip_phone_extension(phone)'],
    emit: allDialectsRegexp('\\s*(?:ext\\.?|extension|x)\\s*#?\\s*\\d+\\s*$', '', {
      caseInsensitive: true,
    }),
  },
  {
    name: 'normalize_phone',
    minArgs: 1,
    maxArgs: 1,
    category: 'string',
    description: 'Normalize a phone number to digits and remove a leading US/Canada country code.',
    examples: ['normalize_phone(phone)'],
    emit: allDialects((args, d) => normalizePhone(args[0]!, d)),
  },
  {
    name: 'normalize_state',
    minArgs: 1,
    maxArgs: 1,
    category: 'string',
    description: 'Normalize US state names and abbreviations to two-letter state codes.',
    examples: ['normalize_state(state)'],
    emit: allDialects((args, d) => normalizeState(args[0]!, d)),
  },
  {
    name: 'expand_street_abbreviations',
    minArgs: 1,
    maxArgs: 1,
    category: 'string',
    description:
      'Canonicalize USPS street suffixes, secondary unit designators, and directionals to short forms.',
    examples: ['expand_street_abbreviations(street_address)'],
    emit: allDialects((args, d) => applyAddressTokenMap(args[0]!, d)),
  },
  {
    name: 'normalize_street',
    minArgs: 1,
    maxArgs: 1,
    category: 'string',
    description:
      'Lowercase, strip punctuation, collapse whitespace, and canonicalize USPS street address tokens.',
    examples: ['normalize_street(street_address)'],
    emit: allDialects((args, d) => normalizeStreet(args[0]!, d)),
  },
  {
    name: 'normalize_postal',
    minArgs: 1,
    maxArgs: 1,
    category: 'string',
    description:
      'Normalize postal codes by trimming, uppercasing, compacting separators, and reducing US ZIP+4 to ZIP5.',
    examples: ['normalize_postal(postal_code)'],
    emit: allDialects((args, d) => normalizePostal(args[0]!, d)),
  },
  {
    name: 'remove_punctuation',
    minArgs: 1,
    maxArgs: 1,
    category: 'string',
    description: 'Remove all punctuation characters, leaving letters, digits, and spaces.',
    examples: ['remove_punctuation(company_name)'],
    emit: allDialectsRegexp('[^a-zA-Z0-9 ]', '', { global: true }),
  },
  {
    name: 'normalize_company',
    minArgs: 1,
    maxArgs: 1,
    category: 'string',
    description: 'Trim, remove legal suffixes, lowercase, and collapse company-name whitespace.',
    examples: ['normalize_company(company_name)'],
    emit: allDialects((args, d) => normalizeCompany(args[0]!, d)),
  },
  {
    name: 'fingerprint',
    minArgs: 1,
    maxArgs: 1,
    category: 'string',
    description:
      'Build an OpenRefine-style clustering key by cleaning, tokenizing, sorting, and deduping terms.',
    examples: ['fingerprint(company_name)'],
    emit: allDialects((args, d) => fingerprint(args[0]!, d)),
  },
  {
    name: 'parse_number',
    minArgs: 1,
    maxArgs: 1,
    category: 'conversion',
    description:
      'Parse formatted number strings by removing currency symbols, commas, and whitespace.',
    examples: ['parse_number(amount_text)'],
    emit: allDialects((args, d) => parseNumber(args[0]!, d)),
  },
  {
    name: 'sha256',
    minArgs: 1,
    maxArgs: 1,
    category: 'hash',
    description:
      'Hash a value with SHA-256 and emit a lowercase hex digest where the dialect supports it.',
    examples: ['sha256(email)'],
    emit: allDialects((args, d) => emitSha256Expr(args[0]!, d)),
  },
  {
    name: 'hmac_sha256',
    minArgs: 1,
    maxArgs: 1,
    category: 'hash',
    description:
      'Privacy-preserving keyed match hash using DOGSLED_MATCH_KEY_SECRET and a portable nested SHA-256 construction.',
    examples: ['hmac_sha256(normalize_email_uid2(email))'],
    emit: allDialects((args, d) => keyedDoubleSha256(args[0]!, d)),
  },
  {
    name: 'parse_date',
    minArgs: 2,
    maxArgs: 2,
    category: 'datetime',
    description:
      "Parse a string column to a typed date or timestamp. Format must be one of 'iso8601', 'timestamp', 'date', 'unix_seconds', 'unix_millis', 'us', or 'eu'.",
    examples: [
      "parse_date(created_at, 'iso8601')",
      "parse_date(event_date, 'date')",
      "parse_date(close_date, 'us')",
    ],
    emit: allDialects((args, d) => emitParseDate(args[0]!, stripQuotes(args[1] ?? ''), d)),
  },
];

function safeCast(expr: string, sqlType: string, dialect: SupportedDialect): string {
  switch (getCanonicalDialect(dialect)) {
    case 'bigquery':
      return `SAFE_CAST(${expr} AS ${sqlType})`;
    case 'databricks':
      return `try_cast(${expr} AS ${sqlType})`;
    case 'duckdb':
    case 'snowflake':
      return `TRY_CAST(${expr} AS ${sqlType})`;
    case 'clickhouse':
      // ClickHouse has no TRY_CAST; accurateCastOrNull is its NULL-on-failure
      // form and takes the target type as a string instead of after AS.
      return `accurateCastOrNull(${expr}, ${quoteLiteral(sqlType, dialect)})`;
    default:
      return `CAST(${expr} AS ${sqlType})`;
  }
}

function timestampType(dialect: SupportedDialect): string {
  return getCanonicalDialect(dialect) === 'mysql' ? 'DATETIME' : 'TIMESTAMP';
}

function numericType(dialect: SupportedDialect): string {
  const canonical = getCanonicalDialect(dialect);
  // ClickHouse has no unparameterized NUMERIC, and Float64 would round money
  // values, so it joins MySQL on exact Decimal.
  return canonical === 'mysql' || canonical === 'clickhouse' ? 'DECIMAL(38, 9)' : 'NUMERIC';
}

function intType(dialect: SupportedDialect): string {
  switch (getCanonicalDialect(dialect)) {
    case 'bigquery':
      return 'INT64';
    case 'mysql':
      return 'SIGNED';
    case 'snowflake':
      return 'NUMBER';
    default:
      return 'BIGINT';
  }
}

function floatType(dialect: SupportedDialect): string {
  switch (getCanonicalDialect(dialect)) {
    case 'bigquery':
      return 'FLOAT64';
    case 'postgres':
      return 'DOUBLE PRECISION';
    case 'mysql':
      return 'DECIMAL(20, 3)';
    default:
      return 'DOUBLE';
  }
}

function emitParseDate(expr: string, format: string, dialect: SupportedDialect): string {
  switch (format) {
    case 'iso8601':
    case 'timestamp':
      return safeCast(expr, timestampType(dialect), dialect);
    case 'date':
      return safeCast(expr, 'DATE', dialect);
    case 'us':
      return emitFormattedDate(expr, 'us', dialect);
    case 'eu':
      return emitFormattedDate(expr, 'eu', dialect);
    case 'unix_seconds': {
      const castSeconds = safeCast(expr, intType(dialect), dialect);
      if (dialect === 'redshift') {
        return `TIMESTAMP 'epoch' + (${castSeconds}) * INTERVAL '1 second'`;
      }
      switch (getCanonicalDialect(dialect)) {
        case 'bigquery':
          return `TIMESTAMP_SECONDS(${castSeconds})`;
        case 'databricks':
          return `timestamp_seconds(${castSeconds})`;
        case 'mysql':
          return `FROM_UNIXTIME(${castSeconds})`;
        case 'clickhouse':
          // Not `toDateTime`: that is UInt32-backed and covers only 1970-2106,
          // so a pre-1970 or far-future epoch throws instead of round-tripping.
          // DateTime64 spans 1900-2299 and matches what the unix_millis branch
          // returns, keeping the two formats the same type.
          return `toDateTime64(${castSeconds}, 3)`;
        default:
          return `to_timestamp(${castSeconds})`;
      }
    }
    case 'unix_millis': {
      const canonical = getCanonicalDialect(dialect);
      const castMillis =
        canonical === 'bigquery' || canonical === 'databricks' || canonical === 'clickhouse'
          ? safeCast(expr, intType(dialect), dialect)
          : safeCast(expr, floatType(dialect), dialect);
      if (dialect === 'redshift') {
        return `TIMESTAMP 'epoch' + (${castMillis} / 1000.0) * INTERVAL '1 second'`;
      }
      switch (canonical) {
        case 'bigquery':
          return `TIMESTAMP_MILLIS(${castMillis})`;
        case 'databricks':
          return `timestamp_millis(${castMillis})`;
        case 'mysql':
          return `FROM_UNIXTIME(${castMillis} / 1000.0)`;
        case 'clickhouse':
          // fromUnixTimestamp64Milli takes Int64, which is why ClickHouse uses
          // the integer cast above rather than the float one.
          return `fromUnixTimestamp64Milli(${castMillis})`;
        default:
          return `to_timestamp(${castMillis} / 1000.0)`;
      }
    }
    default:
      throw new Error(
        `Unsupported parse_date format "${format}". Expected one of: iso8601, timestamp, date, unix_seconds, unix_millis, us, eu.`
      );
  }
}

function emitFormattedDate(expr: string, format: 'us' | 'eu', dialect: SupportedDialect): string {
  const snowflakeFormat = format === 'us' ? 'MM/DD/YYYY' : 'DD/MM/YYYY';
  const strftimeFormat = format === 'us' ? '%m/%d/%Y' : '%d/%m/%Y';
  const databricksFormat = format === 'us' ? 'MM/dd/yyyy' : 'dd/MM/yyyy';
  switch (getCanonicalDialect(dialect)) {
    case 'snowflake':
      return `TRY_TO_DATE(${expr}, ${quoteLiteral(snowflakeFormat, dialect)})`;
    case 'bigquery':
      return `SAFE.PARSE_DATE(${quoteLiteral(strftimeFormat, dialect)}, ${expr})`;
    case 'postgres':
      return `TO_DATE(${expr}, ${quoteLiteral(snowflakeFormat, dialect)})`;
    case 'databricks':
      return `TO_DATE(${expr}, ${quoteLiteral(databricksFormat, dialect)})`;
    case 'duckdb':
      return `strptime(${expr}, ${quoteLiteral(strftimeFormat, dialect)})::DATE`;
    case 'mysql':
      return `STR_TO_DATE(${expr}, ${quoteLiteral(strftimeFormat, dialect)})`;
    case 'clickhouse':
      // parseDateTime takes MySQL-style specifiers, so it reuses the strptime format.
      return `toDate(parseDateTimeOrNull(${expr}, ${quoteLiteral(strftimeFormat, dialect)}))`;
  }
}
