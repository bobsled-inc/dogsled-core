import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnDogsledCommand, collectOutput, getWorkspaceRoot } from './dogsled-cli';
import {
  readEntityGraphSql,
  withEntityGraphWorkspaceQuery,
} from './entity-graph-workspace-inventory.js';
export { readEntityGraphSql, withEntityGraphWorkspaceQuery };
export type { EntityGraphWorkspaceQuery } from './entity-graph-workspace-inventory.js';
import { resolveSafePathWithinRoot as resolveSafePathWithinRootShared } from './path-safety.js';
import {
  ENTITY_GRAPH_DEFAULT_ENTITY,
  ENTITY_GRAPH_DEFAULT_RESOLUTION_SPEC,
  ENTITY_GRAPH_DEFAULT_SURVIVORSHIP_SPEC,
} from './entity-graph-constants';
import {
  getEntityGraphScenarioDefinition,
  isEntityGraphEntityId,
  isEntityGraphScenarioId,
  type EntityGraphEntityId,
  type EntityGraphScenarioId,
} from './entity-graph-scenarios';

export const ENTITY_GRAPH_DEMO_DIR_NAME = path.join('workspace', 'entity-graph-demo');
export const ENTITY_GRAPH_SCHEMA = 'entity_graph_demo';
export const ENTITY_GRAPH_RUNNER_FILENAME = 'runner.duckdb.js';
export {
  ENTITY_GRAPH_DEFAULT_ENTITY,
  ENTITY_GRAPH_DEFAULT_RESOLUTION_SPEC,
  ENTITY_GRAPH_DEFAULT_SURVIVORSHIP_SPEC,
};

function normalizeScenarioId(scenario: EntityGraphScenarioId | undefined): EntityGraphScenarioId {
  return scenario ?? 'default';
}

export function getEntityGraphWorkspaceRoot(scenario?: EntityGraphScenarioId): string {
  return path.join(
    getWorkspaceRoot(),
    getEntityGraphScenarioDefinition(normalizeScenarioId(scenario)).workspaceDir
  );
}

export function getEntityGraphSpecsDir(scenario?: EntityGraphScenarioId): string {
  return path.join(getEntityGraphWorkspaceRoot(scenario), 'entity-graph');
}

export function getEntityGraphRunnerPath(scenario?: EntityGraphScenarioId): string {
  return path.join(getEntityGraphWorkspaceRoot(scenario), ENTITY_GRAPH_RUNNER_FILENAME);
}

export function getEntityGraphRunsLogPath(scenario?: EntityGraphScenarioId): string {
  return path.join(getEntityGraphWorkspaceRoot(scenario), '.runs.jsonl');
}

/**
 * Resolve a path inside the Entity Graph workspace, rejecting anything that escapes it.
 * Useful when a caller supplies a spec name or file name from a request.
 */
export function resolveSafePathWithinRoot(root: string, subpath: string): string {
  return resolveSafePathWithinRootShared(root, subpath);
}

export function resolveSafeEntityGraphPath(
  subpath: string,
  scenario?: EntityGraphScenarioId
): string {
  return resolveSafePathWithinRootShared(getEntityGraphWorkspaceRoot(scenario), subpath);
}

const SPEC_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function assertValidSpecName(name: string): string {
  if (!SPEC_NAME_RE.test(name)) {
    throw new Error('Spec name must match [a-zA-Z0-9_-]{1,64}');
  }
  return name;
}

export function assertSupportedDemoEntity(
  entity: string,
  scenario?: EntityGraphScenarioId
): EntityGraphEntityId {
  const safeEntity = assertValidSpecName(entity);
  const scenarioDef = getEntityGraphScenarioDefinition(normalizeScenarioId(scenario));
  if (!scenarioDef.supportedEntities.includes(safeEntity as EntityGraphEntityId)) {
    throw new Error(`Unsupported demo entity "${safeEntity}" for scenario "${scenarioDef.id}"`);
  }
  return safeEntity as EntityGraphEntityId;
}

export function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Allowed suffixes for `<entity>__<suffix>` tables produced by the Dogsled Entity Graph
 * pipeline. New suffixes must be added here explicitly so that
 * `formatEntityGraphTableName` can guarantee a safe, injection-proof identifier.
 */
export const ENTITY_GRAPH_TABLE_SUFFIXES = [
  '__standardized',
  '__candidate_pairs',
  '__pair_scores',
  '__review_queue',
  '__review_decisions',
  '__clusters',
  '__crosswalks',
  '__entity_profile',
  '__entity_quality',
  '__golden_record',
  '__survivorship_audit',
] as const;

export type EntityGraphTableSuffix = (typeof ENTITY_GRAPH_TABLE_SUFFIXES)[number];
const ENTITY_GRAPH_TABLE_SUFFIX_SET = new Set<string>(ENTITY_GRAPH_TABLE_SUFFIXES);

export function formatEntityGraphTableName(
  entity: string,
  suffix: EntityGraphTableSuffix,
  scenario?: EntityGraphScenarioId
): string {
  const safeEntity = assertSupportedDemoEntity(entity, scenario);
  if (!ENTITY_GRAPH_TABLE_SUFFIX_SET.has(suffix)) {
    throw new Error(`Unsupported Entity Graph table suffix: ${suffix}`);
  }
  const schema = getEntityGraphScenarioDefinition(normalizeScenarioId(scenario)).schema;
  return `"${schema}"."${safeEntity}${suffix}"`;
}

export function specYamlPath(name: string, scenario?: EntityGraphScenarioId): string {
  assertValidSpecName(name);
  try {
    const ymlPath = resolveSafeEntityGraphPath(path.join('entity-graph', `${name}.yml`), scenario);
    if (existsSync(ymlPath)) return ymlPath;
    const yamlPath = resolveSafeEntityGraphPath(
      path.join('entity-graph', `${name}.yaml`),
      scenario
    );
    return existsSync(yamlPath) ? yamlPath : ymlPath;
  } catch {
    throw new Error('Invalid spec name');
  }
}

export async function listSpecFiles(scenario?: EntityGraphScenarioId): Promise<string[]> {
  const dir = getEntityGraphSpecsDir(scenario);
  const entries = await fs.readdir(dir);
  return entries
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => f.replace(/\.(yml|yaml)$/, ''))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Check whether the Entity Graph demo workspace is materialized (runner + spec exist).
 */
export function isEntityGraphWorkspaceReady(scenario?: EntityGraphScenarioId): boolean {
  return (
    existsSync(getEntityGraphRunnerPath(scenario)) && existsSync(getEntityGraphSpecsDir(scenario))
  );
}

export interface EntityGraphRunLogEntry {
  run_id: string;
  scenario?: EntityGraphScenarioId;
  entity: EntityGraphEntityId;
  resolution_spec: string;
  survivorship_spec: string;
  status: 'success' | 'failed';
  started_at: string;
  finished_at: string;
  failure_step?: string;
  failure_code?: string;
  failure_message?: string;
}

function isEntityGraphRunLogEntry(value: unknown): value is EntityGraphRunLogEntry {
  if (value === null || typeof value !== 'object') return false;
  const entry = value as Partial<EntityGraphRunLogEntry>;
  return (
    typeof entry.run_id === 'string' &&
    (entry.scenario === undefined || isEntityGraphScenarioId(entry.scenario)) &&
    isEntityGraphEntityId(entry.entity) &&
    typeof entry.resolution_spec === 'string' &&
    typeof entry.survivorship_spec === 'string' &&
    (entry.status === 'success' || entry.status === 'failed') &&
    typeof entry.started_at === 'string' &&
    typeof entry.finished_at === 'string' &&
    (entry.failure_step === undefined || typeof entry.failure_step === 'string') &&
    (entry.failure_code === undefined || typeof entry.failure_code === 'string') &&
    (entry.failure_message === undefined || typeof entry.failure_message === 'string')
  );
}

export async function appendRunLog(
  entry: EntityGraphRunLogEntry,
  scenario?: EntityGraphScenarioId
): Promise<void> {
  const scenarioId = normalizeScenarioId(scenario ?? entry.scenario);
  const file = getEntityGraphRunsLogPath(scenarioId);
  const nextEntry = { ...entry, scenario: scenarioId };
  // Single-line JSON entries comfortably fit within typical POSIX O_APPEND atomic write bounds.
  const handle = await fs.open(file, 'a');
  try {
    await handle.writeFile(JSON.stringify(nextEntry) + '\n', 'utf8');
  } finally {
    await handle.close();
  }
}

export async function readRunLog(
  limit = 25,
  scenario?: EntityGraphScenarioId
): Promise<EntityGraphRunLogEntry[]> {
  const scenarioId = normalizeScenarioId(scenario);
  const file = getEntityGraphRunsLogPath(scenarioId);
  if (!existsSync(file)) return [];
  const content = await fs.readFile(file, 'utf8');
  const lines = content.trim().split('\n').filter(Boolean);
  const parsed = lines.map((line) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return null;
    }
  });
  return parsed
    .filter(isEntityGraphRunLogEntry)
    .map((entry) => ({
      run_id: entry.run_id,
      scenario: entry.scenario ?? scenarioId,
      entity: entry.entity,
      resolution_spec: entry.resolution_spec,
      survivorship_spec: entry.survivorship_spec,
      status: entry.status,
      started_at: entry.started_at,
      finished_at: entry.finished_at,
      failure_step: entry.failure_step,
      failure_code: entry.failure_code,
      failure_message: entry.failure_message,
    }))
    .slice(-limit)
    .reverse();
}

/** Re-export shared CLI helpers so Entity Graph routes only need to import from this file. */
export { spawnDogsledCommand, collectOutput };

export function spawnEntityGraphCommand(args: string[], scenario?: EntityGraphScenarioId) {
  return spawnDogsledCommand('entity-graph', args, { cwd: getEntityGraphWorkspaceRoot(scenario) });
}

const CLUSTER_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * Look up a cluster's display name from the entity profile table.
 * Returns null when the workspace is not ready, the id is malformed, the query
 * fails, or no display name is recorded.
 */
export async function fetchEntityGraphClusterDisplayName(
  clusterId: string,
  scenarioId: EntityGraphScenarioId,
  entityId: EntityGraphEntityId
): Promise<string | null> {
  if (!CLUSTER_ID_RE.test(clusterId)) return null;
  if (!isEntityGraphWorkspaceReady(scenarioId)) return null;
  try {
    const safeId = escapeSqlLiteral(clusterId);
    const rows = await withEntityGraphWorkspaceQuery(scenarioId, (query) =>
      query<{ display_name: string | null }>(`
        SELECT display_name
        FROM ${formatEntityGraphTableName(entityId, '__entity_profile', scenarioId)}
        WHERE cluster_id = '${safeId}'
        LIMIT 1
      `)
    );
    const value = rows[0]?.display_name?.trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

/**
 * Build a breadcrumb label for a cluster. Falls back to a truncated cluster id
 * (first 8 chars + ellipsis) when no display name is available.
 */
export function buildClusterBreadcrumbLabel(displayName: string | null, clusterId: string): string {
  const normalized = displayName?.trim();
  if (normalized) return normalized;
  return clusterId.length > 8 ? `${clusterId.slice(0, 8)}…` : clusterId;
}
