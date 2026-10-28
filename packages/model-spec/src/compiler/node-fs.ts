/**
 * Default FileSystem implementation backed by `node:fs`.
 */

import * as fs from 'node:fs';

import type { FileSystem } from './types.js';

/** Node.js `fs` module exposed through the {@link FileSystem} interface. */
export const nodeFs: FileSystem = {
  readFileSync: (p, encoding) => fs.readFileSync(p, encoding),
  existsSync: (p) => fs.existsSync(p),
  readdirSync: (p, opts) => fs.readdirSync(p, opts),
  mkdirSync: (p, opts) => fs.mkdirSync(p, opts),
  writeFileSync: (p, data, encoding) => fs.writeFileSync(p, data, encoding),
  renameSync: (src, dst) => fs.renameSync(src, dst),
};
