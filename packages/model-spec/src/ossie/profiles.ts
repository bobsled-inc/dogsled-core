import { CommandError } from '../errors.js';
import { readOssie011 } from './profile-0.1.1.js';
import { readOssie020Dev0 } from './profile-0.2.0-dev0.js';
import type { ParsedOssieDocument } from './profile-types.js';

export function readOssieProfile(document: unknown, path: string): ParsedOssieDocument {
  if (!document || typeof document !== 'object' || !('version' in document)) {
    throw new CommandError(`${path}: Ossie version is required`, 2);
  }
  if (document.version === '0.1.1') return readOssie011(document, path);
  if (document.version === '0.2.0.dev0') return readOssie020Dev0(document, path);
  throw new CommandError(`${path}: Unsupported Ossie version ${String(document.version)}`, 2);
}

export type { ParsedOssieDocument } from './profile-types.js';
