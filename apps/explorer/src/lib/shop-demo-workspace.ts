import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { DuckDBInstance } from '@duckdb/node-api';
import { getWorkspaceRoot } from './dogsled-cli';

export const SHOP_DEMO_DIR = path.join('workspace', 'shop-demo');
export const SHOP_DEMO_DB = 'demo.db';

export function getShopWorkspaceRoot(): string {
  return path.join(getWorkspaceRoot(), SHOP_DEMO_DIR);
}

export function getShopRunnerPath(): string {
  return path.join(getShopWorkspaceRoot(), 'runner.duckdb.js');
}

export function isShopDemoReady(): boolean {
  return existsSync(path.join(getShopWorkspaceRoot(), SHOP_DEMO_DB));
}

export async function readShopReadme(): Promise<string> {
  return fs.readFile(path.join(getShopWorkspaceRoot(), 'README.md'), 'utf8');
}

export async function getShopFileTree(): Promise<string[]> {
  const root = getShopWorkspaceRoot();
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === SHOP_DEMO_DB || entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        files.push(path.relative(root, fullPath));
      }
    }
  }
  await walk(root);
  return files;
}

export async function listShopModelFiles(): Promise<string[]> {
  const dir = path.join(getShopWorkspaceRoot(), 'models');
  const entries = await fs.readdir(dir);
  return entries.filter((entry) => entry.endsWith('.yml')).sort();
}

export async function readShopModelYaml(fileName: string): Promise<string> {
  if (!/^[a-z0-9_]+\.yml$/.test(fileName)) {
    throw new Error('Invalid model file name');
  }
  return fs.readFile(path.join(getShopWorkspaceRoot(), 'models', fileName), 'utf8');
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === 'bigint' ? Number(value) : value,
    ])
  );
}

export async function runShopSql(sql: string): Promise<Record<string, unknown>[]> {
  const dbPath = path.join(getShopWorkspaceRoot(), SHOP_DEMO_DB);
  const instance = await DuckDBInstance.create(dbPath, { access_mode: 'READ_ONLY' });
  try {
    const connection = await instance.connect();
    try {
      const reader = await connection.runAndReadAll(sql);
      return (reader.getRowObjectsJS() as Record<string, unknown>[]).map(normalizeRow);
    } finally {
      connection.disconnectSync();
    }
  } finally {
    instance.closeSync();
  }
}

export interface ShopMetric {
  name: string;
  description: string;
  expression: string;
  model: string;
  synonyms?: string[];
}

export interface ShopVq {
  name: string;
  nlq: string;
  sql: string;
  tags?: string[];
}

export async function listShopMetricFiles(): Promise<string[]> {
  const dir = path.join(getShopWorkspaceRoot(), 'metrics');
  const entries = await fs.readdir(dir);
  return entries.filter((e) => e.endsWith('.yml')).sort();
}

export async function readShopMetricYaml(fileName: string): Promise<string> {
  if (!/^[a-z0-9_]+\.yml$/.test(fileName)) throw new Error('Invalid metric file name');
  return fs.readFile(path.join(getShopWorkspaceRoot(), 'metrics', fileName), 'utf8');
}

export async function listShopRelationshipFiles(): Promise<string[]> {
  const dir = path.join(getShopWorkspaceRoot(), 'relationships');
  const entries = await fs.readdir(dir);
  return entries.filter((e) => e.endsWith('.yml')).sort();
}

export async function readShopRelationshipYaml(fileName: string): Promise<string> {
  if (!/^[a-z0-9_]+\.yml$/.test(fileName)) throw new Error('Invalid relationship file name');
  return fs.readFile(path.join(getShopWorkspaceRoot(), 'relationships', fileName), 'utf8');
}

export async function listShopVqFiles(): Promise<string[]> {
  const dir = path.join(getShopWorkspaceRoot(), 'vqs');
  const entries = await fs.readdir(dir);
  return entries.filter((e) => e.endsWith('.yml')).sort();
}

export async function readShopVqYaml(fileName: string): Promise<string> {
  if (!/^[a-z0-9_]+\.yml$/.test(fileName)) throw new Error('Invalid VQ file name');
  return fs.readFile(path.join(getShopWorkspaceRoot(), 'vqs', fileName), 'utf8');
}

/** Resolve {model_name} table references in VQ SQL to bare table names. */
export function resolveVqSql(sql: string): string {
  return sql.replace(/\{([a-z0-9_]+)\}/g, '$1');
}

export interface ShopGraphNode {
  id: string;
  label: string;
  layer: 'source' | 'staging' | 'fact' | 'dimension';
}

export interface ShopGraphEdge {
  from: string;
  to: string;
}

function inferLayer(name: string): ShopGraphNode['layer'] {
  if (name.startsWith('stg_')) return 'staging';
  if (name.startsWith('fct_')) return 'fact';
  if (name.startsWith('dim_')) return 'dimension';
  return 'source';
}

/** Strip a dialect prefix (e.g. "duckdb.raw_customers" → "raw_customers"). */
function stripDialect(ref: string): string {
  return ref.includes('.') ? ref.split('.').pop()! : ref;
}

export async function buildShopModelGraph(): Promise<{
  nodes: ShopGraphNode[];
  edges: ShopGraphEdge[];
}> {
  const files = await listShopModelFiles();
  const nodes = new Map<string, ShopGraphNode>();
  const edges: ShopGraphEdge[] = [];

  // First pass: collect all model names so we can create nodes for raw sources too
  const allRefs = new Set<string>();

  interface ModelYaml {
    name: string;
    source?: { ref?: string };
    joins?: Array<{ ref?: string }>;
  }

  const parsed: Array<{ name: string; source?: string; joins: string[] }> = [];
  const { default: yamlLib } = await import('yaml');

  for (const file of files) {
    const yamlText = await readShopModelYaml(file);
    const doc = yamlLib.parse(yamlText) as ModelYaml;
    const name = doc.name ?? file.replace(/\.yml$/, '');
    const sourceRef = doc.source?.ref ? stripDialect(doc.source.ref) : undefined;
    const joinRefs = (doc.joins ?? [])
      .map((j) => (j.ref ? stripDialect(j.ref) : null))
      .filter((r): r is string => r !== null);

    if (sourceRef) allRefs.add(sourceRef);
    joinRefs.forEach((r) => allRefs.add(r));
    allRefs.add(name);

    parsed.push({ name, source: sourceRef, joins: joinRefs });
  }

  // Create nodes for every ref seen
  for (const ref of allRefs) {
    nodes.set(ref, { id: ref, label: ref, layer: inferLayer(ref) });
  }

  // Second pass: build edges from explicit source + join refs
  for (const { name, source, joins } of parsed) {
    if (source && nodes.has(source) && source !== name) {
      edges.push({ from: source, to: name });
    }
    for (const join of joins) {
      if (nodes.has(join) && join !== name) {
        edges.push({ from: join, to: name });
      }
    }
  }

  // Deduplicate edges
  const seen = new Set<string>();
  const dedupedEdges = edges.filter(({ from, to }) => {
    const key = `${from}→${to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { nodes: [...nodes.values()], edges: dedupedEdges };
}

export async function compileShopModel(modelName: string): Promise<string> {
  if (!/^[a-z0-9_]+$/.test(modelName)) {
    throw new Error('Invalid model name');
  }
  const repoRoot = getWorkspaceRoot();
  const entrypoint = path.join(repoRoot, 'packages/dogsled/src/index.ts');
  const child = spawn(
    'pnpm',
    ['exec', 'tsx', entrypoint, 'model', 'compile', modelName, '--integration', 'duckdb'],
    { cwd: getShopWorkspaceRoot(), env: { ...process.env, NO_COLOR: '1' } }
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    return stderr || stdout || `Compile failed with exit code ${exitCode}`;
  }
  return stdout.trim();
}
