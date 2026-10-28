import * as fs from 'node:fs';

import YAML from 'yaml';
import { collectYamlFiles } from '@bobsled-inc/model-spec';

export interface DiscoverSpecsOfTypeOptions {
  label?: string;
  makeError?: (message: string) => Error;
}

function defaultError(message: string): Error {
  return new Error(message);
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

function rawSpecType(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return undefined;
  return (raw as { readonly type?: unknown }).type;
}

export function discoverSpecsOfType<T>(
  mdmDir: string,
  typeTag: string,
  parseOne: (filePath: string, raw: unknown) => T,
  options: DiscoverSpecsOfTypeOptions = {}
): T[] {
  const makeError = options.makeError ?? defaultError;
  const label = options.label ?? typeTag;
  let yamlFiles: string[];
  try {
    yamlFiles = collectYamlFiles(mdmDir);
  } catch (err: unknown) {
    if (isEnoent(err)) return [];
    const msg = err instanceof Error ? err.message : String(err);
    throw makeError(`Failed to discover ${label} specs in ${mdmDir}: ${msg}`);
  }

  const specs: T[] = [];
  for (const filePath of yamlFiles) {
    let raw: unknown;
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      raw = YAML.parse(content);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw makeError(`Failed to parse ${label} spec ${filePath}: ${msg}`);
    }

    if (rawSpecType(raw) !== typeTag) {
      continue;
    }

    specs.push(parseOne(filePath, raw));
  }

  return specs;
}
