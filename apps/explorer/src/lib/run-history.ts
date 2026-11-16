import { isExplorerBobsledCommand, type ExplorerBobsledCommand } from './command-links.js';
import { loadStoredJson, removeStoredValue, saveStoredJson } from '@/lib/storage';

export interface RunRecord {
  id: string;
  command: string;
  args: string[];
  sequence?: ExplorerBobsledCommand[];
  startedAt: number;
  endedAt: number;
  exitCode: number | null;
  stdoutLines: string[];
  integration?: string;
  integrations?: string[];
  dbPath?: string;
}

const RUN_HISTORY_STORAGE_KEY = 'bobsled-explorer-run-history';
const MAX_RUN_HISTORY = 50;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined || isStringArray(value);
}

function isOptionalSequence(value: unknown): value is ExplorerBobsledCommand[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every(isExplorerBobsledCommand));
}

function isRunRecord(value: unknown): value is RunRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['id'] === 'string' &&
    typeof record['command'] === 'string' &&
    isStringArray(record['args']) &&
    isOptionalSequence(record['sequence']) &&
    isFiniteNumber(record['startedAt']) &&
    isFiniteNumber(record['endedAt']) &&
    isNullableNumber(record['exitCode']) &&
    isStringArray(record['stdoutLines']) &&
    isOptionalString(record['integration']) &&
    isOptionalStringArray(record['integrations']) &&
    isOptionalString(record['dbPath'])
  );
}

function isRunRecordArray(value: unknown): value is RunRecord[] {
  return Array.isArray(value) && value.every(isRunRecord);
}

export function loadRuns(): RunRecord[] {
  return loadStoredJson<RunRecord[]>(RUN_HISTORY_STORAGE_KEY, [], isRunRecordArray);
}

export function saveRun(run: RunRecord): RunRecord[] {
  const next = [run, ...loadRuns().filter((entry) => entry.id !== run.id)].slice(
    0,
    MAX_RUN_HISTORY
  );
  saveStoredJson(RUN_HISTORY_STORAGE_KEY, next);
  return next;
}

export function clearRuns(): void {
  removeStoredValue(RUN_HISTORY_STORAGE_KEY);
}
