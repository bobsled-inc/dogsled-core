/**
 * State that waits for the rest of a pipeline. The stages after the extractor still run when
 * it has read its last file, so a bookmark saved then can pass files that never arrive.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { lstatSync, realpathSync, type Stats } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CommandError } from '@bobsled-inc/protocol';
import { z } from 'zod';

import { ExtractorStateSchema } from '../schemas/state.js';
import type { ExtractorState } from '../types/index.js';

import { ExtractorTransientError } from './errors.js';
import type { StateStore } from './state.js';

/** A backend that can tell whether its state is still the one it loaded. */
interface VersionedStateStore extends StateStore {
  readonly version?: string;
}

const StagedStateSchema = z
  .object({
    /** The streams this run changed, complete. */
    streams: ExtractorStateSchema.shape.streams,
    /** The backend's version of the state that the run started from. */
    version: z.string().optional(),
  })
  .strict();

/**
 * The file for staged state, in a folder that only this user can open. Where the folder is does
 * not matter: a run can give its processes another temp folder than the one it uses itself.
 */
export function resolveStagedStatePath(cwd: string, file: string): string {
  const resolved = path.resolve(cwd, file);
  const folder = path.dirname(resolved);
  let stats: Stats;
  try {
    stats = lstatSync(folder);
  } catch {
    throw new CommandError('The folder for staged state does not exist.', 2);
  }
  const uid = process.getuid?.();
  const isPrivate =
    stats.isDirectory() &&
    (uid === undefined
      ? isInside(folder, os.tmpdir()) || isInside(folder, cwd)
      : stats.uid === uid && (stats.mode & 0o077) === 0);
  if (isPrivate) return resolved;
  throw new CommandError('The folder for staged state is not private to this user.', 2);
}

function isInside(folder: string, root: string): boolean {
  const relative = path.relative(realpathSync(root), realpathSync(folder));
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Keeps what a run that loaded `state` from `backend` saves in `file`, for `commitStagedState`. */
export class StagedStateStore implements StateStore {
  private readonly loaded: ReadonlyMap<string, unknown>;
  private readonly version: string | undefined;

  constructor(
    private readonly backend: VersionedStateStore,
    state: ExtractorState,
    private readonly file: string
  ) {
    this.loaded = new Map(Object.entries(state.streams));
    this.version = backend.version;
  }

  load(): Promise<ExtractorState> {
    return this.backend.load();
  }

  async save(state: ExtractorState): Promise<void> {
    // A run replaces the bookmark of a stream, so an unchanged one is the object it loaded.
    const streams = Object.fromEntries(
      Object.entries(state.streams).filter(([key, bookmark]) => this.loaded.get(key) !== bookmark)
    );
    const tmpPath = `${this.file}.${randomUUID()}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify({ streams, version: this.version }), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await fs.rename(tmpPath, this.file);
  }
}

/** The store of an `extract run --staged-state`, which is a pipeline's for one integration. */
export function openStagedState(
  cwd: string,
  backend: StateStore,
  state: ExtractorState,
  options: { integration?: string; stagedState?: string }
): StateStore {
  if (!options.integration || options.stagedState === undefined) {
    throw new CommandError('--staged-state needs --integration.', 2);
  }
  return new StagedStateStore(backend, state, resolveStagedStatePath(cwd, options.stagedState));
}

/**
 * Save staged state through the backend. Streams that another run saved in the meantime stay.
 * A backend with versions refuses when its state is not the one the run started from.
 */
export async function commitStagedState(backend: VersionedStateStore, file: string): Promise<void> {
  const staged = await readStagedState(file);
  const state = await backend.load();
  if (staged.version !== undefined && backend.version !== staged.version) {
    throw new ExtractorTransientError(
      'The saved state changed while this run was embedding and loading, so its new state was not saved.'
    );
  }
  await backend.save({ streams: { ...state.streams, ...staged.streams } });
}

async function readStagedState(file: string): Promise<z.infer<typeof StagedStateSchema>> {
  try {
    return StagedStateSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch {
    // A parser's message would quote the state, which names files.
    throw new CommandError('The staged state cannot be read.', 1);
  }
}
