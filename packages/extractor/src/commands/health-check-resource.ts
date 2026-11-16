import * as fs from 'node:fs';
import * as path from 'node:path';

import YAML from 'yaml';

import { normalizeForEachConfig } from '../runtime/for-each.js';

import type { ApiResourceSpec } from '../types/index.js';
import { ROOT_CONFIG_FILE_SPELLINGS } from '@bobsled-inc/project-index';

const BOBSLED_CORE_CONFIG_NAMES = [
  ...new Set(['bobsled.yml', 'bobsled.yaml', ...ROOT_CONFIG_FILE_SPELLINGS]),
];
const MAX_BOBSLED_CORE_CONFIG_BYTES = 1024 * 1024;

/** The root configuration files of the nearest folder that has any; the project resolver merges them. */
function findBobsledConfigs(startDir: string): string[] {
  let dir = path.resolve(startDir);

  while (true) {
    const found = BOBSLED_CORE_CONFIG_NAMES.map((name) => path.join(dir, name)).filter(
      (candidate) => fs.existsSync(candidate)
    );
    if (found.length) return found;

    const parent = path.dirname(dir);
    if (parent === dir) {
      return [];
    }
    dir = parent;
  }
}

export function readScopedHealthResource(
  startDir: string,
  integrationName: string
): string | undefined {
  for (const configPath of findBobsledConfigs(startDir)) {
    const resource = readScopedHealthResourceFrom(configPath, integrationName);
    if (resource) return resource;
  }
  return undefined;
}

function readScopedHealthResourceFrom(
  configPath: string,
  integrationName: string
): string | undefined {
  try {
    const stats = fs.statSync(configPath);
    if (stats.size > MAX_BOBSLED_CORE_CONFIG_BYTES) {
      return undefined;
    }

    const raw = YAML.parse(fs.readFileSync(configPath, 'utf-8')) as
      | {
          pipelines?: Record<string, string | { only?: unknown }>;
        }
      | undefined;
    const entry = raw?.pipelines?.[integrationName];
    if (!entry || typeof entry === 'string' || Array.isArray(entry)) {
      return undefined;
    }

    const only = entry.only;
    if (!Array.isArray(only)) {
      return undefined;
    }

    return only.find((value): value is string => typeof value === 'string' && value.length > 0);
  } catch {
    return undefined;
  }
}

function hasUnboundRequiredInputs(resource: ApiResourceSpec): boolean {
  return Object.values(resource.input ?? {}).some(
    (input) => input.required === true && input.default === undefined
  );
}

export function isHealthCheckCandidate(resource: ApiResourceSpec): boolean {
  if (resource.api) {
    const method = resource.api.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return false;
    }
  }

  if (hasUnboundRequiredInputs(resource)) {
    return false;
  }

  return !normalizeForEachConfig(
    resource.extract && 'for_each' in resource.extract ? resource.extract.for_each : undefined
  );
}

function isPreferredHealthCheckCandidate(resource: ApiResourceSpec): boolean {
  return resource.health_check?.preferred === true && isHealthCheckCandidate(resource);
}

export function selectHealthCheckResource(
  resources: ApiResourceSpec[],
  scopedResourceName?: string
): ApiResourceSpec {
  if (resources.length === 0) {
    throw new Error('No resources available for health check');
  }

  const preferredResource = resources.find(isPreferredHealthCheckCandidate);
  const firstSafeCandidate = resources.find(isHealthCheckCandidate);

  if (scopedResourceName) {
    const scoped = resources.find((resource) => resource.name === scopedResourceName);
    if (
      scoped &&
      isHealthCheckCandidate(scoped) &&
      (scoped.health_check?.preferred === true || !preferredResource)
    ) {
      return scoped;
    }
  }

  if (preferredResource) {
    return preferredResource;
  }

  if (firstSafeCandidate) {
    return firstSafeCandidate;
  }

  throw new Error('No safe resources available for health check');
}
