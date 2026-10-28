import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

import type {
  MetricSpecFile,
  ModelPackageManifest,
  ModelSpecFile,
  RelationshipSpecFile,
} from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the marts directory from either source (`src/definitions/`) or
 * tsup-bundled output (`dist/`). In source the file is two levels below the
 * package root; in the bundle it is one level below.
 */
function resolveMartsDir(): string {
  const fromSource = join(__dirname, '..', '..', 'marts');
  if (existsSync(fromSource)) return fromSource;
  return join(__dirname, '..', 'marts');
}

const MARTS_DIR = resolveMartsDir();

interface PackageYaml {
  name: string;
  display_name: string;
  description: string;
  tags: string[];
  connection?: string;
  include_resources?: string[];
}

const yamlCache = new Map<string, unknown>();

function readYaml(filePath: string): unknown {
  const cached = yamlCache.get(filePath);
  if (cached !== undefined) return cached;
  const content = readFileSync(filePath, 'utf-8');
  const parsed: unknown = parseYaml(content);
  yamlCache.set(filePath, parsed);
  return parsed;
}

function loadPackageManifest(integrationDir: string): ModelPackageManifest {
  const packagePath = join(integrationDir, 'package.yml');
  const pkg = readYaml(packagePath) as PackageYaml;

  const martFiles = readdirSync(integrationDir)
    .filter((f) => f.endsWith('.yml') && f !== 'package.yml')
    .sort();

  const marts: ModelSpecFile[] = martFiles.map(
    (f) => readYaml(join(integrationDir, f)) as ModelSpecFile
  );
  const metrics = loadEntityDirectory<MetricSpecFile>(integrationDir, 'metrics');
  const relationships = loadEntityDirectory<RelationshipSpecFile>(integrationDir, 'relationships');

  return {
    name: pkg.name,
    displayName: pkg.display_name,
    description: pkg.description,
    tags: pkg.tags,
    connection: pkg.connection,
    includeResources: pkg.include_resources,
    marts,
    metrics,
    relationships,
  };
}

function loadEntityDirectory<T>(integrationDir: string, entityDir: string): T[] {
  const dir = join(integrationDir, entityDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .sort()
    .map((file) => readYaml(join(dir, file)) as T);
}

function discoverPackages(): ModelPackageManifest[] {
  if (!existsSync(MARTS_DIR)) return [];

  return readdirSync(MARTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => existsSync(join(MARTS_DIR, entry.name, 'package.yml')))
    .map((entry) => loadPackageManifest(join(MARTS_DIR, entry.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const modelPackageDefinitions: ModelPackageManifest[] = discoverPackages();

export function clearDefinitionsCache(): void {
  yamlCache.clear();
}
