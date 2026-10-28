import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { CommandError } from '@bobsled-inc/protocol';

import type { SqlParamValue } from '@bobsled-inc/connections';

export interface Lease {
  sync_name: string;
  pid: number;
  host: string;
  owner: string;
  acquired_at: string;
  ttl_seconds: number;
}

export interface SyncCheckpoint {
  cursor_value: SqlParamValue;
  tie_breaker_values: SqlParamValue[];
  idempotency_key?: string;
  updated_at: string;
  run_id: string;
}

export interface SyncRunCounters {
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

export interface SyncRunSummary {
  run_id: string;
  sync_name: string;
  status: 'running' | 'completed' | 'aborted' | 'failed';
  started_at: string;
  ended_at?: string;
  dry_run: boolean;
  counters: SyncRunCounters;
  last_error?: string;
}

export interface SyncReceipt {
  run_id: string;
  sync_name: string;
  entity_key: Record<string, unknown>;
  idempotency_key: string;
  action: string;
  status: 'success' | 'failed' | 'skipped';
  target_record_id?: string;
  attempted_at: string;
  duration_ms: number;
  error?: unknown;
}

export interface SyncDeadLetter {
  run_id: string;
  sync_name: string;
  entity_key: Record<string, unknown>;
  action: string;
  error: unknown;
  payload_snapshot: string;
  occurred_at: string;
}

/** A request to atomically reserve a record's idempotency key before its action runs. */
export interface SyncActionIdempotencyClaim {
  idempotency_key: string;
  entity_key: Record<string, unknown>;
  action: string;
}

/**
 * Outcome of {@link SyncStateStore.claimSyncActionIdempotencyKey}.
 *
 * - `claimed` — the key was reserved; the caller must execute the action.
 * - `already_succeeded` — the action already completed for this key; the caller
 *   must skip execution to avoid a duplicate external side effect.
 */
export type SyncActionIdempotencyClaimResult =
  | { status: 'claimed' }
  | { status: 'already_succeeded'; target_record_id?: string };

export interface SyncStateStore {
  acquireLease(syncName: string, ttlSeconds: number): Promise<Lease>;
  releaseLease(lease: Lease): Promise<void>;
  loadCheckpoint(syncName: string): Promise<SyncCheckpoint | null>;
  saveCheckpoint(syncName: string, checkpoint: SyncCheckpoint): Promise<void>;
  startRun(syncName: string, runId: string, summary: SyncRunSummary): Promise<void>;
  finishRun(syncName: string, runId: string, summary: SyncRunSummary): Promise<void>;
  appendReceipt(syncName: string, runId: string, receipt: SyncReceipt): Promise<void>;
  appendDeadLetter(syncName: string, runId: string, deadLetter: SyncDeadLetter): Promise<void>;
  /**
   * Optional pre-action idempotency hook for reverse-ETL syncs. Managed runtimes
   * implement this to atomically claim a record's idempotency key *before* the
   * destination action executes, so retries or concurrent invocations cannot
   * create duplicate external side effects (e.g. duplicate Notion pages).
   *
   * Stores that omit it — including {@link FileSyncStateStore} — fall back to
   * executing every action, preserving existing behavior.
   */
  claimSyncActionIdempotencyKey?(
    syncName: string,
    runId: string,
    claim: SyncActionIdempotencyClaim
  ): Promise<SyncActionIdempotencyClaimResult>;
}

const MAX_JSONL_LINE_BYTES = 1_024 * 1_024;

function assertSafeStatePathPart(part: string): void {
  if (
    part.length === 0 ||
    part === '.' ||
    part === '..' ||
    isAbsolute(part) ||
    part.includes('/') ||
    part.includes('\\') ||
    part.includes('\0')
  ) {
    throw new CommandError(`Unsafe state path component: ${JSON.stringify(part)}`, 2);
  }
}

function assertContained(rootReal: string, candidate: string): void {
  const resolved = resolve(candidate);
  const rel = relative(rootReal, resolved);
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new CommandError(`State path escapes root: ${candidate}`, 2);
  }
}

/**
 * Reject symlinks in every existing component below the state root.
 *
 * A lexical `path.relative` check is insufficient because an attacker can place
 * `<root>/<sync>/runs -> /outside` and make an otherwise-contained filename
 * escape when it is opened. This walk is repeated after directory creation and
 * immediately before each read/write to keep that window as small as Node's
 * path-based filesystem APIs permit.
 */
function assertNoSymlinkComponents(rootReal: string, candidate: string): void {
  assertContained(rootReal, candidate);
  const rel = relative(rootReal, resolve(candidate));
  if (rel === '') return;

  let current = rootReal;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new CommandError(`Refusing to use symlink state path ${current}`, 2);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }
}

function ensureSafeParent(rootReal: string, filePath: string): void {
  const parent = dirname(filePath);
  assertNoSymlinkComponents(rootReal, parent);
  mkdirSync(parent, { recursive: true });
  assertNoSymlinkComponents(rootReal, parent);
  const parentReal = realpathSync(parent);
  assertContained(rootReal, parentReal);
}

function writeJsonAtomic(rootReal: string, filePath: string, value: unknown): void {
  ensureSafeParent(rootReal, filePath);
  assertNoSymlinkComponents(rootReal, filePath);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  assertNoSymlinkComponents(rootReal, tmp);
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    assertNoSymlinkComponents(rootReal, dirname(filePath));
    assertNoSymlinkComponents(rootReal, filePath);
    renameSync(tmp, filePath);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

function readJson<T>(rootReal: string, filePath: string): T | null {
  assertNoSymlinkComponents(rootReal, filePath);
  let fd: number;
  try {
    fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  try {
    return JSON.parse(readFileSync(fd, 'utf-8')) as T;
  } finally {
    closeSync(fd);
  }
}

async function appendJsonLine(rootReal: string, filePath: string, value: unknown): Promise<void> {
  ensureSafeParent(rootReal, filePath);
  assertNoSymlinkComponents(rootReal, filePath);
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line, 'utf-8') > MAX_JSONL_LINE_BYTES) {
    throw new CommandError(`Refusing to write JSONL line larger than 1 MB to ${filePath}`, 1);
  }
  const handle = await open(
    filePath,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o600
  );
  try {
    await handle.writeFile(line, 'utf8');
  } finally {
    await handle.close();
  }
  assertNoSymlinkComponents(rootReal, filePath);
}

export class FileSyncStateStore implements SyncStateStore {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    mkdirSync(rootDir, { recursive: true });
    this.rootDir = realpathSync(rootDir);
  }

  // File-based leasing is advisory; concurrent processes that start
  // simultaneously may both acquire before either writes. Use flock or
  // O_EXCL for stronger guarantees in future state backends.
  async acquireLease(syncName: string, ttlSeconds: number): Promise<Lease> {
    const dir = this.path(syncName);
    mkdirSync(dir, { recursive: true });
    assertNoSymlinkComponents(this.rootDir, dir);
    const leasePath = this.path(syncName, 'lease.json');

    const existing = readJson<Lease>(this.rootDir, leasePath);
    if (existing) {
      const expiresAt = Date.parse(existing.acquired_at) + existing.ttl_seconds * 1000;
      if (Date.now() < expiresAt) {
        throw new CommandError(`Sync "${syncName}" is already leased by ${existing.owner}.`, 1);
      }
    }

    const lease: Lease = {
      sync_name: syncName,
      pid: process.pid,
      host: hostname(),
      owner: `${hostname()}:${process.pid}`,
      acquired_at: new Date().toISOString(),
      ttl_seconds: ttlSeconds,
    };
    writeJsonAtomic(this.rootDir, leasePath, lease);
    return lease;
  }

  async releaseLease(lease: Lease): Promise<void> {
    const leasePath = this.path(lease.sync_name, 'lease.json');
    const current = readJson<Lease>(this.rootDir, leasePath);
    if (current?.owner === lease.owner && current.acquired_at === lease.acquired_at) {
      assertNoSymlinkComponents(this.rootDir, leasePath);
      rmSync(leasePath, { force: true });
    }
  }

  async loadCheckpoint(syncName: string): Promise<SyncCheckpoint | null> {
    return readJson<SyncCheckpoint>(this.rootDir, this.path(syncName, 'checkpoint.json'));
  }

  async saveCheckpoint(syncName: string, checkpoint: SyncCheckpoint): Promise<void> {
    writeJsonAtomic(this.rootDir, this.path(syncName, 'checkpoint.json'), checkpoint);
  }

  async startRun(syncName: string, runId: string, summary: SyncRunSummary): Promise<void> {
    writeJsonAtomic(this.rootDir, this.path(syncName, 'runs', `${runId}.json`), summary);
  }

  async finishRun(syncName: string, runId: string, summary: SyncRunSummary): Promise<void> {
    writeJsonAtomic(this.rootDir, this.path(syncName, 'runs', `${runId}.json`), summary);
  }

  async appendReceipt(syncName: string, runId: string, receipt: SyncReceipt): Promise<void> {
    await appendJsonLine(this.rootDir, this.path(syncName, 'receipts', `${runId}.jsonl`), receipt);
  }

  async appendDeadLetter(
    syncName: string,
    runId: string,
    deadLetter: SyncDeadLetter
  ): Promise<void> {
    await appendJsonLine(
      this.rootDir,
      this.path(syncName, 'dead-letters', `${runId}.jsonl`),
      deadLetter
    );
  }

  private path(syncName: string, ...parts: string[]): string {
    for (const part of [syncName, ...parts]) {
      assertSafeStatePathPart(part);
    }
    const candidate = join(this.rootDir, syncName, ...parts);
    assertContained(this.rootDir, candidate);
    assertNoSymlinkComponents(this.rootDir, candidate);
    return candidate;
  }
}

export function truncatePayloadSnapshot(value: unknown): string {
  const raw = JSON.stringify(value);
  return raw.length > 16_384 ? `${raw.slice(0, 16_384)}...` : raw;
}
