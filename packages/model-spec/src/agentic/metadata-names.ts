/**
 * Names of the agentic metadata columns across Core generations.
 *
 * Core writes the current names. Saved runs, executor output and existing
 * warehouse tables may carry an earlier spelling (legacy-names.ts), so readers
 * map every spelling: digests use one fixed canonical spelling, so a run's
 * identity is the same whichever generation started it, and rows written to a
 * warehouse use the current names.
 */
import { AGENTIC_METADATA_SPELLINGS, RESERVED_AGENTIC_COLUMN_PREFIXES } from './legacy-names.js';

export const AGENTIC_METADATA_NAMES = Object.freeze({
  run_id: '_bobsled_run_id',
  evidence: '_bobsled_evidence',
  confidence: '_bobsled_confidence',
  reason: '_bobsled_reason',
} as const);

export type AgenticMetadataRole = keyof typeof AGENTIC_METADATA_NAMES;

const ROLES = Object.keys(AGENTIC_METADATA_NAMES) as AgenticMetadataRole[];
const roleByName = new Map<string, AgenticMetadataRole>();
for (const role of ROLES) {
  const spellings = [...AGENTIC_METADATA_SPELLINGS[role], AGENTIC_METADATA_NAMES[role]];
  for (const name of spellings) roleByName.set(name, role);
}

/** The metadata role of `name` in any generation, matched case-insensitively. */
export function agenticMetadataRole(name: string): AgenticMetadataRole | undefined {
  return roleByName.get(name.toLowerCase());
}

/** True for any generation of a metadata column name. */
export function isAgenticMetadataName(name: string): boolean {
  return agenticMetadataRole(name) !== undefined;
}

/** True when a user column name uses a prefix Core reserves for its own columns. */
export function usesReservedAgenticPrefix(name: string): boolean {
  const lower = name.toLowerCase();
  return RESERVED_AGENTIC_COLUMN_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** All spellings of one role, current first. */
export function agenticMetadataSpellings(role: AgenticMetadataRole): string[] {
  const current = AGENTIC_METADATA_NAMES[role];
  return [current, ...AGENTIC_METADATA_SPELLINGS[role].filter((name) => name !== current)];
}

/** Earlier spellings of a current metadata column name. */
export function legacyAgenticMetadataNames(name: string): string[] {
  const role = agenticMetadataRole(name);
  return role === undefined ? [] : agenticMetadataSpellings(role).slice(1);
}

function mapRowKeys(value: unknown, to: (role: AgenticMetadataRole) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => mapRowKeys(item, to));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const role = roleByName.get(key);
      return [role === undefined ? key : to(role), item];
    })
  );
}

function mapColumnNames(value: unknown, to: (role: AgenticMetadataRole) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => mapColumnNames(item, to));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (key === 'name' && typeof item === 'string') {
        const role = roleByName.get(item);
        return [key, role === undefined ? item : to(role)];
      }
      return [key, mapColumnNames(item, to)];
    })
  );
}

const canonical = (role: AgenticMetadataRole) => AGENTIC_METADATA_SPELLINGS[role][0]!;
const current = (role: AgenticMetadataRole) => AGENTIC_METADATA_NAMES[role];

/**
 * Rows (one or a list): the top-level metadata keys spelled the canonical way that digests use.
 * Values, including nested user data, are never touched.
 */
export function canonicalAgenticNames<T>(value: T): T {
  return mapRowKeys(value, canonical) as T;
}

/** Rows (one or a list): the top-level metadata keys spelled the way Core writes them now. */
export function currentAgenticNames<T>(value: T): T {
  return mapRowKeys(value, current) as T;
}

/**
 * A definition or column list: every column `name` that is a metadata name, spelled the
 * canonical way that digests use. Nothing else is touched.
 */
export function canonicalAgenticDefinition<T>(value: T): T {
  return mapColumnNames(value, canonical) as T;
}

/** A row's value for one metadata role, under whichever spelling the row uses. */
export function agenticMetadataValue(
  row: Readonly<Record<string, unknown>>,
  role: AgenticMetadataRole
): unknown {
  for (const name of agenticMetadataSpellings(role)) {
    if (Object.hasOwn(row, name)) return row[name];
  }
  return undefined;
}
