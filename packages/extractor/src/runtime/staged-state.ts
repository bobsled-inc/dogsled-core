/**
 * State that waits for the rest of a pipeline. The stages after the extractor still run when
 * it has read its last file, so a bookmark saved then can pass files that never arrive.
 */

import * as fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
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

/** The file for staged state, in an existing folder of the system's temp folder or the project. */
export function resolveStagedStatePath(cwd: string, file: string): string {
  const resolved = path.resolve(cwd, file);
  const isInside = (root: string): boolean => {
    const relative = path.relative(realpathSync(root), realpathSync(path.dirname(resolved)));
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  };
  try {
    if ([os.tmpdir(), cwd].some(isInside)) return resolved;
  } catch {
    throw new CommandError('The folder for staged state does not exist.', 2);
  }
  throw new CommandError('Staged state must be within temp directory or project root.', 2);
}

/** Loads from `backend`, and keeps what a run saves in `file` for `commitStagedState`. */
export class StagedStateStore implements StateStore {
  private loaded = new Map<string, unknown>();
  private version: string | undefined;

  constructor(
    private readonly backend: VersionedStateStore,
    private readonly file: string
  ) {}

  async load(): Promise<ExtractorState> {
    const state = await this.backend.load();
    this.loaded = new Map(Object.entries(state.streams));
    this.version = this.backend.version;
    return state;
  }

  async save(state: ExtractorState): Promise<void> {
    // A run replaces the bookmark of a stream, so an unchanged one is the object it loaded.
    const streams = Object.fromEntries(
      Object.entries(state.streams).filter(([key, bookmark]) => this.loaded.get(key) !== bookmark)
    );
    const tmpPath = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify({ streams, version: this.version }), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(tmpPath, this.file);
  }
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
