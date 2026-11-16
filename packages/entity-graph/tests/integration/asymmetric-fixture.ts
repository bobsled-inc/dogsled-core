/**
 * Builds a realistic asymmetric two-input resolution project on disk.
 *
 * Mirrors the production repro that escaped the string-assertion unit tests:
 *  - `accounts_a` (account_id, name, slug)        — has `slug`, no `domain`
 *  - `accounts_b` (pylon_id,  name, domain)       — has `domain`, no `slug`
 *  - resolution standardizes `name`, `slug`, `domain` (slug only exists on A,
 *    domain only on B) so the UNION ALL branches must NULL-pad asymmetrically.
 *  - scoring uses `jaro_winkler` and `token_cosine` on `standardized_name` so
 *    BigQuery emits both temp-function SQL UDFs and DuckDB executes both fuzzy
 *    scorers.
 *
 * Used by both the pure-compile BigQuery validity test and the in-process
 * DuckDB execution test.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const RESOLUTION_TARGET_SCHEMA = 'entity_graph';
export const ENTITY_NAME = 'account';
export const STANDARDIZED_TABLE = 'account__standardized';
export const PAIR_SCORES_TABLE = 'account__pair_scores';
export const ADDRESS_PAIR_SCORES_TABLE = 'address__pair_scores';
export const ADDRESS_CANDIDATE_PAIRS_TABLE = 'address__candidate_pairs';
export const INCREMENTAL_STANDARDIZED_DELTA_TABLE = 'account__standardized_delta';
export const INTEGRATION_HANDLE = 'lake';
export const SOURCE_A_REF = 'lake.accounts_a';
export const SOURCE_B_REF = 'lake.accounts_b';

const MODEL_SPEC_YML = `sources_dir: sources
entity_graph_dir: entity-graph
integrations_dir: integrations
`;

const SOURCE_A_YML = `spec_version: '0.2'
name: accounts_a
type: source
source_type: warehouse_table
connection: lake
table: main.accounts_a
schema:
  columns:
    - { name: account_id, type: STRING }
    - { name: name, type: STRING }
    - { name: slug, type: STRING }
`;

const SOURCE_B_YML = `spec_version: '0.2'
name: accounts_b
type: source
source_type: warehouse_table
connection: lake
table: main.accounts_b
schema:
  columns:
    - { name: pylon_id, type: STRING }
    - { name: name, type: STRING }
    - { name: domain, type: STRING }
`;

const RESOLUTION_YML = `spec_version: '0.2'
type: resolution
name: account_resolution
description: Resolve account entities across two asymmetric source systems.
inputs:
  - ref: lake.accounts_a
    role: internal
    trust_tier: gold
    id_fields: [account_id]
  - ref: lake.accounts_b
    role: internal
    trust_tier: silver
    id_fields: [pylon_id]
standardize:
  - field: name
    transforms: [lowercase, trim]
  - field: slug
    transforms: [lowercase, trim]
  - field: domain
    transforms: [lowercase, trim]
blocking:
  rules:
    - name: by_name
      key: standardized_name
scoring:
  method: weighted_features
  features:
    - field: standardized_name
      algorithm: jaro_winkler
      weight: 0.4
    - field: standardized_name
      algorithm: token_cosine
      weight: 0.2
    - field: standardized_domain
      algorithm: exact
      weight: 0.4
thresholds:
  auto_merge: 0.9
  review: 0.6
  auto_reject: 0.3
outputs:
  target_schema: entity_graph
`;

const INCREMENTAL_SOURCE_A_YML = `spec_version: '0.2'
name: accounts_a
type: source
source_type: warehouse_table
connection: lake
table: main.accounts_a
schema:
  columns:
    - { name: account_id, type: STRING }
    - { name: name, type: STRING }
    - { name: loaded_at, type: TIMESTAMP }
`;

const INCREMENTAL_SOURCE_B_YML = `spec_version: '0.2'
name: accounts_b
type: source
source_type: warehouse_table
connection: lake
table: main.accounts_b
schema:
  columns:
    - { name: pylon_id, type: STRING }
    - { name: name, type: STRING }
    - { name: loaded_at, type: TIMESTAMP }
`;

const INCREMENTAL_RESOLUTION_YML = `spec_version: '0.2'
type: resolution
name: account_resolution
description: Resolve account entities with loaded_at incremental watermarks.
inputs:
  - ref: lake.accounts_a
    role: internal
    trust_tier: gold
    id_fields: [account_id]
  - ref: lake.accounts_b
    role: provider
    trust_tier: silver
    id_fields: [pylon_id]
standardize:
  - field: name
    transforms: [lowercase, trim]
blocking:
  rules:
    - name: by_name
      key: standardized_name
scoring:
  method: weighted_features
  features:
    - field: standardized_name
      algorithm: exact
      weight: 1.0
thresholds:
  auto_merge: 0.95
  review: 0.6
  auto_reject: 0.3
profile:
  display_name:
    field: standardized_name
  attributes:
    - field: standardized_name
      alias: name
outputs:
  target_schema: entity_graph
`;

const ADDRESS_SOURCE_A_YML = `spec_version: '0.2'
name: addresses_a
type: source
source_type: warehouse_table
connection: lake
table: main.addresses_a
schema:
  columns:
    - { name: address_id, type: STRING }
    - { name: street, type: STRING }
    - { name: postal_code, type: STRING }
`;

const ADDRESS_SOURCE_B_YML = `spec_version: '0.2'
name: addresses_b
type: source
source_type: warehouse_table
connection: lake
table: main.addresses_b
schema:
  columns:
    - { name: provider_id, type: STRING }
    - { name: street, type: STRING }
    - { name: postal_code, type: STRING }
`;

const ADDRESS_RESOLUTION_YML = `spec_version: '0.2'
type: resolution
name: address_resolution
description: Resolve addresses with USPS street and postal normalization.
inputs:
  - ref: lake.addresses_a
    role: internal
    trust_tier: gold
    id_fields: [address_id]
  - ref: lake.addresses_b
    role: provider
    trust_tier: silver
    id_fields: [provider_id]
standardize:
  - field: street
    transforms: [normalize_street]
  - field: postal_code
    transforms: [normalize_postal]
blocking:
  rules:
    - name: by_normalized_street
      key: standardized_street
scoring:
  method: weighted_features
  features:
    - field: standardized_street
      algorithm: exact
      weight: 0.5
    - field: standardized_postal_code
      algorithm: exact
      weight: 0.5
thresholds:
  auto_merge: 0.95
  review: 0.6
  auto_reject: 0.3
outputs:
  target_schema: entity_graph
`;

// ---------------------------------------------------------------------------
// No-schema-columns fixture (asymmetric raw column counts)
//
// Mirrors the live account_resolution_poc repro where neither lakehouse source
// declares schema.columns. Input A has 5 raw columns; input B has 3. The
// standardize step must NOT use `src.*` (wildcard) — different raw column
// counts make the UNION ALL invalid. The fix projects only bookkeeping +
// standardized fields, which are always uniform.
//
// Connection handle: `main` — matches DuckDB's default schema so the source
// registry fallback (triggered when sources lack schema.columns and fail the
// strict SourceSpecSchema parse) builds the right FQ table name:
//   buildFqName('main', 'neon_accounts', 'duckdb') → "main"."neon_accounts"
// In production (BigQuery) the equivalent is the dataset name prefix, e.g.
//   buildFqName('bobsled_managed', 'demo_daily__accounts', 'bigquery')
// ---------------------------------------------------------------------------

export const NO_COL_INTEGRATION_HANDLE = 'main';
export const NO_COL_SOURCE_A_REF = 'main.neon_accounts';
export const NO_COL_SOURCE_B_REF = 'main.pylon_accounts';

// Sources intentionally lack `schema.columns` so SourceSpecSchema.safeParse
// fails → source is skipped from the registry → sourceColumns = undefined →
// exercises the mixed-mode passthrough-drop path in generateStandardizeSql.
const NO_COL_SOURCE_A_YML = `spec_version: '0.2'
name: neon_accounts
type: source
source_type: warehouse_table
connection: main
table: main.neon_accounts
`;

const NO_COL_SOURCE_B_YML = `spec_version: '0.2'
name: pylon_accounts
type: source
source_type: warehouse_table
connection: main
table: main.pylon_accounts
`;

const NO_COL_RESOLUTION_YML = `spec_version: '0.2'
type: resolution
name: account_resolution
description: Resolve accounts with no column metadata declared.
inputs:
  - ref: main.neon_accounts
    role: internal
    trust_tier: gold
    id_fields: [neon_id]
  - ref: main.pylon_accounts
    role: internal
    trust_tier: silver
    id_fields: [pylon_id]
standardize:
  - field: name
    transforms: [lowercase, trim]
blocking:
  rules:
    - name: by_name
      key: standardized_name
scoring:
  method: weighted_features
  features:
    - field: standardized_name
      algorithm: exact
      weight: 1.0
thresholds:
  auto_merge: 0.9
  review: 0.6
  auto_reject: 0.3
outputs:
  target_schema: entity_graph
`;

function escapeYamlDoubleQuoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function noColDuckdbIntegrationYml(dbPath: string): string {
  const safePath = escapeYamlDoubleQuoted(dbPath);
  return `spec_version: '1'
type: integration
name: main
source_type: duckdb
connection:
  schema: main
auth:
  type: file
  path: "${safePath}"
`;
}

export interface WriteNoColumnsFixtureOptions {
  duckdbDbPath?: string;
}

/**
 * Write the no-schema-columns resolution project. Input A has 5 raw columns;
 * input B has 3. Neither declares `schema.columns`, exercising the mixed-mode
 * passthrough-drop path in `generateStandardizeSql`.
 */
export async function writeNoColumnsFixture(
  dir: string,
  options: WriteNoColumnsFixtureOptions = {}
): Promise<void> {
  await mkdir(join(dir, 'sources'), { recursive: true });
  await mkdir(join(dir, 'entity-graph'), { recursive: true });
  await writeFile(join(dir, 'model-spec.yml'), MODEL_SPEC_YML, 'utf8');
  await writeFile(join(dir, 'sources', 'neon_accounts.yml'), NO_COL_SOURCE_A_YML, 'utf8');
  await writeFile(join(dir, 'sources', 'pylon_accounts.yml'), NO_COL_SOURCE_B_YML, 'utf8');
  await writeFile(
    join(dir, 'entity-graph', 'account_resolution.yml'),
    NO_COL_RESOLUTION_YML,
    'utf8'
  );

  if (options.duckdbDbPath !== undefined) {
    await mkdir(join(dir, 'integrations'), { recursive: true });
    await writeFile(
      join(dir, 'integrations', 'main.yml'),
      noColDuckdbIntegrationYml(options.duckdbDbPath),
      'utf8'
    );
  }
}

function duckdbIntegrationYml(dbPath: string): string {
  const safePath = escapeYamlDoubleQuoted(dbPath);
  return `spec_version: '1'
type: integration
name: lake
source_type: duckdb
connection:
  schema: main
auth:
  type: file
  path: "${safePath}"
`;
}

export interface WriteFixtureOptions {
  /** When set, writes `integrations/lake.yml` as a file-backed DuckDB integration. */
  duckdbDbPath?: string;
}

/**
 * Write the asymmetric resolution project (model-spec.yml, two sources, resolution
 * spec) into `dir`. When `duckdbDbPath` is given, also writes a DuckDB
 * integration so the project can run end-to-end via `--integration lake`.
 */
export async function writeAsymmetricFixture(
  dir: string,
  options: WriteFixtureOptions = {}
): Promise<void> {
  await mkdir(join(dir, 'sources'), { recursive: true });
  await mkdir(join(dir, 'entity-graph'), { recursive: true });
  await writeFile(join(dir, 'model-spec.yml'), MODEL_SPEC_YML, 'utf8');
  await writeFile(join(dir, 'sources', 'accounts_a.yml'), SOURCE_A_YML, 'utf8');
  await writeFile(join(dir, 'sources', 'accounts_b.yml'), SOURCE_B_YML, 'utf8');
  await writeFile(join(dir, 'entity-graph', 'account_resolution.yml'), RESOLUTION_YML, 'utf8');

  if (options.duckdbDbPath !== undefined) {
    await mkdir(join(dir, 'integrations'), { recursive: true });
    await writeFile(
      join(dir, 'integrations', 'lake.yml'),
      duckdbIntegrationYml(options.duckdbDbPath),
      'utf8'
    );
  }
}

export async function writeIncrementalFixture(
  dir: string,
  options: WriteFixtureOptions = {}
): Promise<void> {
  await mkdir(join(dir, 'sources'), { recursive: true });
  await mkdir(join(dir, 'entity-graph'), { recursive: true });
  await writeFile(join(dir, 'model-spec.yml'), MODEL_SPEC_YML, 'utf8');
  await writeFile(join(dir, 'sources', 'accounts_a.yml'), INCREMENTAL_SOURCE_A_YML, 'utf8');
  await writeFile(join(dir, 'sources', 'accounts_b.yml'), INCREMENTAL_SOURCE_B_YML, 'utf8');
  await writeFile(
    join(dir, 'entity-graph', 'account_resolution.yml'),
    INCREMENTAL_RESOLUTION_YML,
    'utf8'
  );
  if (options.duckdbDbPath !== undefined) {
    await mkdir(join(dir, 'integrations'), { recursive: true });
    await writeFile(
      join(dir, 'integrations', `${INTEGRATION_HANDLE}.yml`),
      duckdbIntegrationYml(options.duckdbDbPath),
      'utf8'
    );
  }
}

export async function writeAddressFixture(
  dir: string,
  options: WriteFixtureOptions = {}
): Promise<void> {
  await mkdir(join(dir, 'sources'), { recursive: true });
  await mkdir(join(dir, 'entity-graph'), { recursive: true });
  await writeFile(join(dir, 'model-spec.yml'), MODEL_SPEC_YML, 'utf8');
  await writeFile(join(dir, 'sources', 'addresses_a.yml'), ADDRESS_SOURCE_A_YML, 'utf8');
  await writeFile(join(dir, 'sources', 'addresses_b.yml'), ADDRESS_SOURCE_B_YML, 'utf8');
  await writeFile(
    join(dir, 'entity-graph', 'address_resolution.yml'),
    ADDRESS_RESOLUTION_YML,
    'utf8'
  );

  if (options.duckdbDbPath !== undefined) {
    await mkdir(join(dir, 'integrations'), { recursive: true });
    await writeFile(
      join(dir, 'integrations', 'lake.yml'),
      duckdbIntegrationYml(options.duckdbDbPath),
      'utf8'
    );
  }
}
