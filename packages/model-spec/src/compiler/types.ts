/**
 * Shared types for the compiler subsystem.
 */

import type { Dirent } from 'node:fs';

// ---------------------------------------------------------------------------
// FileSystem abstraction
// ---------------------------------------------------------------------------

/**
 * Minimal file-system interface used by compiler internals.
 *
 * Consumers can supply a custom implementation (e.g. an in-memory FS for
 * tests or WASM) while the default falls back to `node:fs`.
 */
export interface FileSystem {
  readFileSync(path: string, encoding: 'utf-8'): string;
  existsSync(path: string): boolean;
  readdirSync(path: string, opts: { withFileTypes: true }): Dirent[];
  mkdirSync(path: string, opts: { recursive: true }): void;
  writeFileSync(path: string, data: string, encoding: 'utf-8'): void;
  renameSync(src: string, dst: string): void;
}
