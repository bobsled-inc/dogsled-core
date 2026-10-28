import { describe, expect, it, vi } from 'vitest';
import { emitExpr, parseExprField } from '../../../../src/compiler/expr/index.js';
import {
  MATCH_KEY_SECRET_RUNTIME_TOKEN,
  materializeMatchKeySecretPlaceholders,
  readMatchKeySecret,
  redactMatchKeySecret,
} from '../../../../src/compiler/expr/functions-cleaning.js';
import type { SupportedDialect } from '../../../../src/compiler/dialect.js';

const ALL_DIALECTS: SupportedDialect[] = [
  'snowflake',
  'bigquery',
  'postgres',
  'databricks',
  'mysql',
  'duckdb',
  'clickhouse',
];

// Regex replacement is REGEXP_REPLACE / regexp_replace everywhere except
// ClickHouse, which splits the global and first-match forms into two functions.
const REGEXP_REPLACE_SQL = /REGEXP_REPLACE|replaceRegexp(?:All|One)/i;

function emit(exprStr: string, dialect: SupportedDialect): string {
  return emitExpr(parseExprField(exprStr), dialect);
}

describe('CLEANING_FUNCTIONS — cross-dialect emission', () => {
  describe('collapse_whitespace', () => {
    it('emits REGEXP_REPLACE with \\s+ pattern on all dialects', () => {
      for (const d of ALL_DIALECTS) {
        const sql = emit('collapse_whitespace(company_name)', d);
        expect(sql, `dialect ${d}`).toMatch(REGEXP_REPLACE_SQL);
        expect(sql, `dialect ${d}`).toContain('\\s+');
      }
    });
  });

  describe('strip_legal_suffixes', () => {
    it('emits a case-insensitive REGEXP_REPLACE that targets common suffixes', () => {
      for (const d of ALL_DIALECTS) {
        const sql = emit('strip_legal_suffixes(company_name)', d);
        expect(sql, `dialect ${d}`).toMatch(REGEXP_REPLACE_SQL);
        expect(sql, `dialect ${d}`).toMatch(/inc|llc|corp/i);
      }
    });
  });

  describe('strip_www', () => {
    it('emits a REGEXP_REPLACE that targets http(s):// and www. prefixes', () => {
      for (const d of ALL_DIALECTS) {
        const sql = emit('strip_www(website)', d);
        expect(sql, `dialect ${d}`).toMatch(REGEXP_REPLACE_SQL);
        expect(sql, `dialect ${d}`).toContain('https?://');
      }
    });
  });

  describe('digits_only', () => {
    it('emits a global REGEXP_REPLACE that strips non-digits', () => {
      for (const d of ALL_DIALECTS) {
        const sql = emit('digits_only(phone)', d);
        expect(sql, `dialect ${d}`).toMatch(REGEXP_REPLACE_SQL);
        expect(sql, `dialect ${d}`).toContain('0-9');
      }
    });
  });

  describe('remove_punctuation', () => {
    it('emits a global REGEXP_REPLACE that strips non-alphanumeric/space chars', () => {
      for (const d of ALL_DIALECTS) {
        const sql = emit('remove_punctuation(company_name)', d);
        expect(sql, `dialect ${d}`).toMatch(REGEXP_REPLACE_SQL);
        expect(sql, `dialect ${d}`).toContain('a-zA-Z0-9');
      }
    });
  });

  describe('strip_country_code', () => {
    it('emits a CASE expression checking 11-digit length with leading 1', () => {
      for (const d of ALL_DIALECTS) {
        const sql = emit('strip_country_code(phone)', d);
        expect(sql, `dialect ${d}`).toMatch(/CASE WHEN/i);
        expect(sql, `dialect ${d}`).toContain('11');
        expect(sql, `dialect ${d}`).toContain("'1'");
      }
    });

    it('chains correctly after digits_only', () => {
      for (const d of ALL_DIALECTS) {
        const sql = emit('strip_country_code(digits_only(phone))', d);
        expect(sql, `dialect ${d}`).toMatch(/CASE WHEN/i);
        expect(sql, `dialect ${d}`).toMatch(REGEXP_REPLACE_SQL);
      }
    });

    it('produces different casing for postgres/duckdb vs snowflake/bigquery', () => {
      const pgSql = emit('strip_country_code(phone)', 'postgres');
      const sfSql = emit('strip_country_code(phone)', 'snowflake');
      expect(pgSql).toMatch(/^CASE WHEN length/);
      expect(sfSql).toMatch(/^CASE WHEN LENGTH/);
    });
  });

  describe('parse_date', () => {
    it('snowflake: emits TRY_CAST to TIMESTAMP for iso8601', () => {
      const sql = emit("parse_date(created_at, 'iso8601')", 'snowflake');
      expect(sql).toMatch(/TRY_CAST.*TIMESTAMP/i);
    });

    it('bigquery: emits SAFE_CAST to TIMESTAMP for iso8601', () => {
      const sql = emit("parse_date(created_at, 'iso8601')", 'bigquery');
      expect(sql).toMatch(/SAFE_CAST.*TIMESTAMP/i);
    });

    it('postgres: emits CAST to TIMESTAMP for iso8601', () => {
      const sql = emit("parse_date(created_at, 'iso8601')", 'postgres');
      expect(sql).toMatch(/CAST.*TIMESTAMP/i);
    });

    it('snowflake: emits to_timestamp for unix_seconds', () => {
      const sql = emit("parse_date(ts_col, 'unix_seconds')", 'snowflake');
      expect(sql).toContain('to_timestamp');
    });

    it('bigquery: emits TIMESTAMP_SECONDS for unix_seconds', () => {
      const sql = emit("parse_date(ts_col, 'unix_seconds')", 'bigquery');
      expect(sql).toContain('TIMESTAMP_SECONDS');
    });

    it('bigquery: emits TIMESTAMP_MILLIS for unix_millis', () => {
      const sql = emit("parse_date(ts_col, 'unix_millis')", 'bigquery');
      expect(sql).toContain('TIMESTAMP_MILLIS');
    });

    it('clickhouse: casts through accurateCastOrNull instead of TRY_CAST', () => {
      const sql = emit("parse_date(created_at, 'iso8601')", 'clickhouse');
      expect(sql).toContain('accurateCastOrNull');
      expect(sql).not.toMatch(/TRY_CAST|SAFE_CAST/i);
    });

    it('clickhouse: emits DateTime64 conversions for unix formats', () => {
      // to_timestamp does not exist in ClickHouse, and fromUnixTimestamp64Milli
      // takes Int64, so the milliseconds path must not divide by 1000.
      const seconds = emit("parse_date(ts_col, 'unix_seconds')", 'clickhouse');
      expect(seconds).toContain('toDateTime64(');
      expect(seconds).not.toContain('to_timestamp');
      // Plain toDateTime is UInt32-backed (1970-2106); both unix formats must
      // land on DateTime64 so they share one range and one type.
      expect(seconds).not.toMatch(/\btoDateTime\(/);

      const millis = emit("parse_date(ts_col, 'unix_millis')", 'clickhouse');
      expect(millis).toContain('fromUnixTimestamp64Milli(');
      expect(millis).not.toContain('/ 1000.0');
    });
  });
  describe('new cleaning primitives', () => {
    const cases = [
      ['nullif_empty(blank_text)', /NULLIF\(TRIM/i],
      ['normalize_email(email)', /LOWER\(TRIM/i],
      ['normalize_email_uid2(email)', /gmail\.com|googlemail\.com/i],
      ['extract_email_domain(email)', /SPLIT|split_part|SUBSTRING_INDEX|extract\(/i],
      ['strip_email_subaddress(email)', REGEXP_REPLACE_SQL],
      ['strip_accents(name)', /strip_accents|unaccent|NORMALIZE|TRANSLATE|CONVERT/i],
      ['strip_trading_as(company)', /d\\s\*\/\\s\*b|dba|trading/i],
      ['extract_domain(url)', REGEXP_REPLACE_SQL],
      ['strip_phone_extension(phone)', /ext|extension/i],
      ['normalize_phone(phone)', /CASE WHEN/i],
      ['normalize_state(state)', /CASE UPPER\(TRIM/i],
      ['expand_street_abbreviations(street)', REGEXP_REPLACE_SQL],
      ['normalize_street(street)', REGEXP_REPLACE_SQL],
      ['normalize_postal(postal_code)', /CASE WHEN/i],
      ['normalize_company(company)', /LOWER|lower/i],
      ['fingerprint(company)', /ARRAY|array|list_|CONCAT_WS|REGEXP_REPLACE|regexp_replace/i],
      ['parse_number(amount)', /CAST|cast/i],
      ['sha256(email)', /SHA2|SHA256|sha2|sha256|digest/i],
    ] as const;

    it.each(cases)('emits SQL for %s on all dialects', (expr, pattern) => {
      for (const d of ALL_DIALECTS) {
        expect(emit(expr, d), `dialect ${d}`).toMatch(pattern);
      }
    });

    it('supports US and EU parse_date formats', () => {
      expect(emit("parse_date(close_date, 'us')", 'snowflake')).toContain('MM/DD/YYYY');
      expect(emit("parse_date(close_date, 'eu')", 'bigquery')).toContain('%d/%m/%Y');
    });

    it('canonicalizes common USPS street suffixes, units, and directionals in emitted SQL', () => {
      const sql = emit('expand_street_abbreviations(street)', 'duckdb');
      expect(sql).toContain('STREET');
      expect(sql).toContain('SUITE');
      expect(sql).toContain('NORTH');
      // Secondary-unit designators added for parity with USPS Pub 28 Appendix C2.
      expect(sql).toContain('BASEMENT');
      expect(sql).toContain('FRONT');
    });

    it('uses \\y word boundaries on Postgres (\\b is BACKSPACE in Postgres ARE) and \\b elsewhere', () => {
      // Regression: \b matches the BACKSPACE character in PostgreSQL advanced
      // regular expressions, so \b-delimited address tokens silently never
      // replace anything. Postgres/pgvector must emit \y.
      const pg = emit('expand_street_abbreviations(street)', 'postgres');
      expect(pg).toContain('\\y');
      expect(pg).not.toMatch(/\\b\(\?:/);

      const pgv = emit('expand_street_abbreviations(street)', 'pgvector');
      expect(pgv).toContain('\\y');
      expect(pgv).not.toMatch(/\\b\(\?:/);

      for (const d of [
        'duckdb',
        'bigquery',
        'snowflake',
        'databricks',
        'mysql',
        'clickhouse',
      ] as const) {
        const sql = emit('expand_street_abbreviations(street)', d);
        expect(sql, `dialect ${d} keeps \\b`).toMatch(/\\b\(\?:/);
        expect(sql, `dialect ${d} must not use \\y`).not.toContain('\\y');
      }
    });

    it('emits dialect-specific postal regex checks', () => {
      expect(emit('normalize_postal(postal_code)', 'bigquery')).toContain('REGEXP_CONTAINS');
      expect(emit('normalize_postal(postal_code)', 'duckdb')).toContain('regexp_matches');
      expect(emit('normalize_postal(postal_code)', 'postgres')).toContain(' ~ ');
      expect(emit('normalize_postal(postal_code)', 'snowflake')).toContain('REGEXP_LIKE');
      expect(emit('normalize_postal(postal_code)', 'clickhouse')).toContain('match(');
    });

    it('emits one portable keyed double-hash construction for hmac_sha256', () => {
      vi.stubEnv('DOGSLED_MATCH_KEY_SECRET', 'test-secret');
      try {
        for (const d of ALL_DIALECTS) {
          const sql = emit('hmac_sha256(email)', d);
          expect(sql, `dialect ${d}`).not.toContain('test-secret');
          expect(sql, `dialect ${d}`).toContain(MATCH_KEY_SECRET_RUNTIME_TOKEN);
          expect(materializeMatchKeySecretPlaceholders(sql, d), `dialect ${d}`).toContain(
            'test-secret'
          );
          expect(sql, `dialect ${d}`).toMatch(/SHA2|SHA256|sha2|sha256|digest/i);
        }
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('requires the new key name and preserves the carried-over value and redaction', () => {
      vi.stubEnv('DOGSLED_MATCH_KEY_SECRET', 'example-stable-key');
      vi.stubEnv('DOGSLED_MATCH_KEY_SECRET', '');
      try {
        expect(() => readMatchKeySecret()).toThrow(/DOGSLED_MATCH_KEY_SECRET/);
        vi.stubEnv('DOGSLED_MATCH_KEY_SECRET', 'example-stable-key');
        expect(readMatchKeySecret()).toBe('example-stable-key');
        const sql = emit('hmac_sha256(email)', 'postgres');
        expect(sql).not.toContain('example-stable-key');
        expect(materializeMatchKeySecretPlaceholders(sql, 'postgres')).toContain(
          'example-stable-key'
        );
        expect(redactMatchKeySecret('prefix example-stable-key suffix')).toBe('prefix *** suffix');
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('fails closed when hmac_sha256 has no runtime key', () => {
      vi.stubEnv('DOGSLED_MATCH_KEY_SECRET', '');
      try {
        expect(() => emit('hmac_sha256(email)', 'duckdb')).toThrow(/DOGSLED_MATCH_KEY_SECRET/);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe('strip_email_subaddress — RE2 safety (regression)', () => {
    // RE2-backed engines (BigQuery, Databricks, DuckDB) reject Perl lookaround
    // with "invalid perl operator: (?=". The emitted pattern must never contain
    // a lookahead `(?=` or lookbehind `(?<` on ANY dialect — `[^@]*` already
    // stops at `@`, so the strip is expressed without lookaround.
    it.each(ALL_DIALECTS)('emits an RE2-safe REGEXP_REPLACE with no lookaround for %s', (d) => {
      const sql = emit('strip_email_subaddress(email)', d);
      expect(sql, `dialect ${d}`).toMatch(REGEXP_REPLACE_SQL);
      expect(sql, `dialect ${d}`).not.toContain('(?=');
      expect(sql, `dialect ${d}`).not.toContain('(?<');
      // The RE2-safe character class survives the per-dialect literal escaping.
      expect(sql, `dialect ${d}`).toContain('[^@]*');
    });
  });
});

describe('postal suffix vocabulary', () => {
  it.each(ALL_DIALECTS)('preserves the postal tokens in emitted SQL for %s', (dialect) => {
    const sql = emit('normalize_street(street)', dialect);
    for (const suffix of ['TRACK', 'TRK']) {
      expect(sql).toMatch(new RegExp(`\\b${suffix}\\b`));
    }
    expect(sql).not.toContain('DOGSLED');
  });
});
