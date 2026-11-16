import { existsSync } from 'node:fs';
import * as path from 'node:path';

import { SETUP_ANSWERS_FILE_SPELLINGS } from './legacy-names.js';

export const SETUP_ANSWERS_FILE = 'dogsled.setup.answers.yml';

/**
 * The setup answers file to read: the given path, or, when that is the default name and missing,
 * an existing file under another Core generation's name next to it.
 */
export function resolveSetupAnswersPath(given: string, base = process.cwd()): string {
  const resolved = path.resolve(base, given);
  if (path.basename(given) !== SETUP_ANSWERS_FILE || existsSync(resolved)) return resolved;
  for (const name of SETUP_ANSWERS_FILE_SPELLINGS) {
    const candidate = path.join(path.dirname(resolved), name);
    if (existsSync(candidate)) return candidate;
  }
  return resolved;
}
