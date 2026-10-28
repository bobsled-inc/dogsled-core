/**
 * Cache substrate interface — backs `mode: lazy` and `mode: live` for document resources
 * per the Cache Substrate / Live-Mode Correctness Contract.
 *
 * This module owns the public interface + a DuckDB-backed reference implementation. The
 * Postgres / Snowflake / BigQuery implementations land as separate modules registered
 * via `registerCacheSubstrate()`. The `mode: live` legality rules are enforced here
 * (transactional + idempotent_writes pass; lww fails fast).
 */

import { createHash } from 'node:crypto';

import { ExtractorConfigError, ExtractorDataError } from './errors.js';
import {
  createBigQueryCacheSubstrate,
  createPostgresCacheSubstrate,
  createSnowflakeCacheSubstrate,
} from './cache-substrate-sql.js';

import type { WarehouseClient } from './warehouse-client.js';

export { warehouseClientCacheExecutor } from './cache-substrate-sql.js';

export type AtomicityLevel = 'transaction' | 'idempotent_writes' | 'lww';
export type FtsCapability = 'native_index' | 'full_scan_only' | 'extension_required';
export type VectorCapability = 'native' | 'array_only';
export type CacheSubstrateKind = 'duckdb' | 'ducklake' | 'postgres' | 'snowflake' | 'bigquery';

export interface CacheManifestRow {
  document_id: string;
  document_version_id: string;
  source_uri: string;
  content_hash: string;
  source_revision: string | null;
  etag: string | null;
  mtime: number | null;
  size: number | null;
  embedder_role: string | null;
  embedder_underlying_model: string | null;
  embedding_dimension: number | null;
  parser_versions: Record<string, string>;
  chunker_config_hash: string;
  document_count: number;
  chunk_count: number;
  parse_status: 'parsed' | 'error';
  cached_at: string;
}

export interface CacheWriteHandle {
  /** Resource name this write is scoped to. */
  readonly resource: string;
  /** Implementation-specific connection / transaction handle. */
  readonly inner: unknown;
}

export interface CacheSubstrate {
  readonly kind: CacheSubstrateKind;
  readonly atomicityLevel: AtomicityLevel;
  readonly ftsCapability: FtsCapability;
  readonly vectorCapability: VectorCapability;
  beginCacheWrite(resource: string): Promise<CacheWriteHandle>;
  commitCacheWrite(handle: CacheWriteHandle): Promise<void>;
  abortCacheWrite(handle: CacheWriteHandle): Promise<void>;
  readManifest(resource: string): Promise<CacheManifestRow[]>;
  writeManifestRow(handle: CacheWriteHandle, row: CacheManifestRow): Promise<void>;
}

export interface CacheSqlExecutor {
  /**
   * Executes one SQL statement. Transactional substrates require this executor to
   * keep BEGIN / writes / COMMIT on the same session.
   */
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

export interface CacheSubstrateFactoryOptions {
  executor?: CacheSqlExecutor | WarehouseClient;
  schema?: string;
}

const REGISTRY: Map<
  CacheSubstrate['kind'],
  (options?: CacheSubstrateFactoryOptions) => CacheSubstrate
> = new Map();

export function registerCacheSubstrate(
  kind: CacheSubstrate['kind'],
  factory: (options?: CacheSubstrateFactoryOptions) => CacheSubstrate
): void {
  REGISTRY.set(kind, factory);
}

export function createCacheSubstrate(
  kind: CacheSubstrate['kind'],
  options?: CacheSubstrateFactoryOptions
): CacheSubstrate {
  const factory = REGISTRY.get(kind);
  if (!factory) {
    throw new ExtractorConfigError(
      `No cache substrate registered for kind "${kind}". Did you forget to import the module?`
    );
  }
  return factory(options);
}

/**
 * `mode: live` legality check per the Cache Substrate / Live-Mode Correctness Contract.
 * Returns `{ ok: true }` on `transaction` and `idempotent_writes`, fails fast on `lww`.
 */
export function assertLiveModeSupported(substrate: CacheSubstrate): { warn?: string } {
  switch (substrate.atomicityLevel) {
    case 'transaction':
      return {};
    case 'idempotent_writes':
      return {
        warn:
          `Substrate "${substrate.kind}" uses idempotent-writes semantics for mode: live ` +
          `(staging-table + atomic INSERT/SELECT). dogsled doctor will WARN; behavior is ` +
          `correct but slightly different from session-scoped transactional substrates.`,
      };
    case 'lww':
      // Configuration incompatibility — surface as ExtractorConfigError so retry
      // classification doesn't treat it as a transient/data failure.
      throw new ExtractorConfigError(
        `LIVE_MODE_UNSUPPORTED_SUBSTRATE: substrate "${substrate.kind}" has atomicityLevel ` +
          `"lww" which cannot honor mode: live. Use mode: extract or switch substrates.`
      );
  }
}

/** Cache freshness check — see §Cache Substrate / Live-Mode Correctness Contract. */
export interface FreshnessProbe {
  embedderRole: string | null;
  embedderUnderlyingModel: string | null;
  embeddingDimension: number | null;
  parserVersions: Record<string, string>;
  chunkerConfigHash: string;
}

export interface FreshnessVerdict {
  fresh: boolean;
  reason?:
    | 'embedder_role_changed'
    | 'embedder_model_changed'
    | 'embedding_dimension_changed'
    | 'parser_version_changed'
    | 'chunker_config_changed';
}

export function checkFreshness(
  manifest: CacheManifestRow,
  probe: FreshnessProbe
): FreshnessVerdict {
  if (manifest.embedder_role !== probe.embedderRole) {
    return { fresh: false, reason: 'embedder_role_changed' };
  }
  if (manifest.embedder_underlying_model !== probe.embedderUnderlyingModel) {
    return { fresh: false, reason: 'embedder_model_changed' };
  }
  if (manifest.embedding_dimension !== probe.embeddingDimension) {
    return { fresh: false, reason: 'embedding_dimension_changed' };
  }
  if (manifest.chunker_config_hash !== probe.chunkerConfigHash) {
    return { fresh: false, reason: 'chunker_config_changed' };
  }
  // Iterate the union of manifest and probe parser-version keys so additions,
  // removals, and version changes all invalidate. Without the probe-side keys,
  // adding `html` to a config whose manifest only cached `pdf` would silently
  // return `fresh: true` and skip the new format under lazy/live mode.
  const parserFormats = new Set<string>([
    ...Object.keys(manifest.parser_versions),
    ...Object.keys(probe.parserVersions),
  ]);
  for (const format of parserFormats) {
    const manifestVersion = manifest.parser_versions[format];
    const probeVersion = probe.parserVersions[format];
    if (manifestVersion !== probeVersion) {
      return { fresh: false, reason: 'parser_version_changed' };
    }
  }
  return { fresh: true };
}

/**
 * Stable canonicalization for parser_versions — used as part of the manifest row hash
 * key so equivalent maps with different key ordering produce the same canonical bytes.
 */
export function canonicalizeParserVersions(map: Record<string, string>): string {
  const keys = Object.keys(map).sort();
  const canonical = keys.map((k) => `${k}=${map[k]}`).join('::');
  return createHash('sha256').update(canonical).digest('hex');
}

// ── DuckDB reference implementation ────────────────────────────────────────────────

/**
 * In-memory DuckDB-backed cache substrate. Real DuckDB I/O lands when the loader's
 * existing DuckDbEngine is wired here; for now this implementation provides a working
 * in-memory substrate that exercises the contract end-to-end. Tests + the lazy-mode
 * dispatch use this as the default for local development. See the Cache Substrate /
 * Live-Mode Correctness Contract.
 */
class DuckDbInMemoryCacheSubstrate implements CacheSubstrate {
  readonly atomicityLevel: AtomicityLevel = 'transaction';
  readonly ftsCapability: FtsCapability = 'extension_required';
  readonly vectorCapability: VectorCapability = 'native';

  private readonly manifests = new Map<string, CacheManifestRow[]>();
  private readonly pending = new Map<string, CacheManifestRow[]>();

  constructor(readonly kind: 'duckdb' | 'ducklake' = 'duckdb') {}

  async beginCacheWrite(resource: string): Promise<CacheWriteHandle> {
    if (this.pending.has(resource)) {
      throw new ExtractorDataError(
        `DuckDB cache substrate: a write is already in flight for resource "${resource}"`
      );
    }
    this.pending.set(resource, []);
    return { resource, inner: null };
  }

  async commitCacheWrite(handle: CacheWriteHandle): Promise<void> {
    const buffer = this.pending.get(handle.resource);
    if (!buffer) {
      throw new ExtractorDataError(
        `DuckDB cache substrate: no pending write for resource "${handle.resource}"`
      );
    }
    // Defensive copy at commit so callers that mutated the original buffer rows after
    // commit can't retroactively corrupt persisted state.
    this.manifests.set(handle.resource, buffer.map(cloneRow));
    this.pending.delete(handle.resource);
  }

  async abortCacheWrite(handle: CacheWriteHandle): Promise<void> {
    this.pending.delete(handle.resource);
  }

  async readManifest(resource: string): Promise<CacheManifestRow[]> {
    // Defensive copy on read so callers can't mutate the persisted manifest by
    // pushing/popping or editing field values on the returned snapshot.
    const rows = this.manifests.get(resource) ?? [];
    return rows.map(cloneRow);
  }

  async writeManifestRow(handle: CacheWriteHandle, row: CacheManifestRow): Promise<void> {
    const buffer = this.pending.get(handle.resource);
    if (!buffer) {
      throw new ExtractorDataError(
        `DuckDB cache substrate: write to unstarted resource "${handle.resource}"`
      );
    }
    buffer.push(cloneRow(row));
  }
}

function cloneRow(row: CacheManifestRow): CacheManifestRow {
  return { ...row, parser_versions: { ...row.parser_versions } };
}

registerCacheSubstrate('duckdb', () => new DuckDbInMemoryCacheSubstrate());
registerCacheSubstrate('ducklake', () => new DuckDbInMemoryCacheSubstrate('ducklake'));
registerCacheSubstrate('postgres', createPostgresCacheSubstrate);
registerCacheSubstrate('snowflake', createSnowflakeCacheSubstrate);
registerCacheSubstrate('bigquery', createBigQueryCacheSubstrate);
