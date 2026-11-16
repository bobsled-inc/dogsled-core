import YAML from 'yaml';
import { inputFiles, readBounded } from './files.js';
import { ROOT_CONFIG_FILE_SPELLINGS } from '@bobsled-inc/project-index';

export interface ProjectFile {
  path: string;
  content: string;
  language: string;
}
export interface LineageNode {
  id: string;
  label: string;
  kind: string;
  description: string;
  available: boolean;
}
export interface ProjectLineage {
  nodes: LineageNode[];
  edges: { from: string; to: string }[];
}
const sensitive =
  /secret|password|credential|authorization|api.?key|access.?token|refresh.?token|private.?key|^token$|^key$/i;
function clean(value: unknown, key = ''): unknown {
  if (sensitive.test(key)) {
    return typeof value === 'string' && /^\$[A-Z_][A-Z0-9_]*$/.test(value) ? value : '[REDACTED]';
  }
  if (Array.isArray(value)) return value.map((v) => clean(v));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v, k)]));
  }
  if (typeof value !== 'string') return value;
  let text = value;
  for (const [name, secret] of Object.entries(process.env)) {
    if (sensitive.test(name) && secret) text = text.split(secret).join('[REDACTED]');
  }
  return text
    .replace(/\b(?:sk-[\w-]+|Bearer\s+[\w.-]+)/gi, '[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@')
    .replace(/([?&](?:key|token|secret|password)=)[^\s&#]+/gi, '$1[REDACTED]');
}
export async function projectWorkspace(
  root: string,
  dataDirectory?: string
): Promise<{ files: ProjectFile[]; lineage: ProjectLineage }> {
  const files: ProjectFile[] = [];
  const records: { path: string; value: Record<string, unknown> }[] = [];
  let bytes = 0;
  for (const path of await inputFiles(root, dataDirectory)) {
    // Only authored definitions and SQL. Data, runtime config, executors and environment files stay private.
    if (
      !/^(models|sources|metrics|relationships|integrations|resources|queries|entity-graph)\/[^\n]+\.(ya?ml|sql)$/.test(
        path
      ) &&
      !ROOT_CONFIG_FILE_SPELLINGS.includes(path)
    ) {
      continue;
    }
    const raw = await readBounded(root, path);
    if (
      Buffer.byteLength(raw) > 64 * 1024 ||
      bytes + Buffer.byteLength(raw) > 512 * 1024 ||
      files.length >= 100
    ) {
      continue;
    }
    let content: string;
    if (/\.ya?ml$/.test(path)) {
      const value: unknown = YAML.parse(raw, { maxAliasCount: 0 });
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const safe = clean(value) as Record<string, unknown>;
      content = YAML.stringify(safe);
      records.push({ path, value: safe });
    } else content = String(clean(raw));
    bytes += Buffer.byteLength(content);
    files.push({ path, content, language: path.endsWith('.sql') ? 'sql' : 'yaml' });
  }
  const nodes: LineageNode[] = records.map(({ path, value }) => ({
    id: path,
    label: String(value['name'] ?? path),
    kind: String(value['type'] ?? path.split('/')[0]),
    description: String(value['description'] ?? ''),
    available: true,
  }));
  const edges: ProjectLineage['edges'] = [];
  function link(ref: string, to: string) {
    const record = records.find(({ path, value }) =>
      ref.includes('.')
        ? path.startsWith('sources/') &&
          `${value['connection'] ?? value['integration']}.${value['name']}` === ref
        : path.startsWith('models/') && value['name'] === ref
    );
    const from = record?.path ?? `unresolved:${ref}`;
    if (!nodes.some((n) => n.id === from)) {
      nodes.push({
        id: from,
        label: ref,
        kind: 'source or model',
        description: 'Referenced definition not found in this preview.',
        available: false,
      });
    }
    if (from !== to && !edges.some((e) => e.from === from && e.to === to)) edges.push({ from, to });
  }
  for (const { path, value } of records) {
    if (path.startsWith('relationships/')) continue; // Relationships are not data dependencies.
    const source = value['source'] as { ref?: unknown } | undefined;
    if (typeof source?.ref === 'string') link(source.ref, path);
    const sources = value['sources'];
    if (sources && typeof sources === 'object') {
      for (const v of Object.values(sources)) {
        if (v && typeof v === 'object' && typeof v.ref === 'string') link(v.ref, path);
      }
    }
    if (Array.isArray(value['joins'])) {
      for (const v of value['joins']) if (v && typeof v.ref === 'string') link(v.ref, path);
    }
    if (path.startsWith('metrics/') && typeof value['model'] === 'string') {
      link(value['model'], path);
    }
    if (typeof value['integration'] === 'string') {
      const parent = records.find(
        (r) =>
          r.path.startsWith(value['resource'] ? 'resources/' : 'integrations/') &&
          r.value['name'] === (value['resource'] ?? value['integration']) &&
          (!value['resource'] || r.value['integration'] === value['integration'])
      );
      if (parent) edges.push({ from: parent.path, to: path });
    }
  }
  // Connect API resources to raw sources only when an explicit ETL destination and table agree.
  for (const config of records.filter((r) => ROOT_CONFIG_FILE_SPELLINGS.includes(r.path))) {
    const destinations = config.value['destinations'] as
      Record<string, { schema?: string }> | undefined;
    const pipelines = config.value['pipelines'];
    if (!pipelines || typeof pipelines !== 'object') continue;
    for (const pipeline of Object.values(pipelines)) {
      if (
        !pipeline ||
        !Array.isArray(pipeline.resources) ||
        typeof pipeline.destination !== 'string'
      ) {
        continue;
      }
      const schema = destinations?.[pipeline.destination]?.schema;
      if (!schema) continue;
      for (const selected of pipeline.resources) {
        const name = typeof selected === 'string' ? selected : selected?.resource;
        const resource = records.find(
          (r) =>
            r.path.startsWith('resources/') &&
            r.value['name'] === name &&
            r.value['integration'] === pipeline.source
        );
        if (!resource || typeof name !== 'string') continue;
        const table = `${schema}.${pipeline.table_prefix ?? ''}${name}`;
        for (const source of records.filter(
          (r) =>
            r.path.startsWith('sources/') &&
            r.value['connection'] === pipeline.destination &&
            r.value['table'] === table
        )) {
          edges.push({ from: resource.path, to: source.path });
        }
      }
    }
  }
  return { files, lineage: { nodes, edges } };
}
