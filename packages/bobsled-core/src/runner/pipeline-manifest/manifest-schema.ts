import { z } from 'zod';

import { parseToCron } from '../schedule/parser.js';
import { PIPELINE_MANIFEST_COMPAT_VERSIONS } from './template.js';

const MAX_STRING_LENGTH = 4_096;
const MAX_COMMAND_TOKENS = 256;
const MAX_COLLECTION_ITEMS = 10_000;
const MAX_GRAPH_EDGES = 50_000;

const nonEmptyString = z.string().min(1).max(MAX_STRING_LENGTH);
const commandSchema = z.array(nonEmptyString).min(1).max(MAX_COMMAND_TOKENS);
const edgeSchema = z
  .object({
    from: nonEmptyString,
    to: nonEmptyString,
  })
  .strict();
const scheduleSchema = z
  .object({
    expression: nonEmptyString,
    cron: nonEmptyString,
  })
  .strict();
const triggerSchema = z.enum(['schedule', 'manual']);
const schemaBehaviorSchema = z.enum(['evolve', 'strict', 'freeze']);
const replicationSchema = z
  .object({
    method: z.enum(['full_refresh', 'incremental_append', 'incremental_merge', 'change_tracking']),
    cursor_field: nonEmptyString.optional(),
  })
  .strict();
const loadSchema = z
  .object({
    integration: nonEmptyString.optional(),
    destinations: z.array(nonEmptyString).min(1).optional(),
    destination_settings: z
      .record(
        nonEmptyString,
        z
          .object({
            load_strategy: z.enum(['append', 'merge', 'full_refresh']).optional(),
            schema_behavior: schemaBehaviorSchema.optional(),
            table_prefix: z.string().max(MAX_STRING_LENGTH).optional(),
          })
          .strict()
      )
      .refine((settings) => Object.keys(settings).length <= MAX_COLLECTION_ITEMS, {
        message: `Destination settings cannot exceed ${MAX_COLLECTION_ITEMS} entries.`,
      })
      .optional(),
    load_strategy: z.enum(['append', 'merge', 'full_refresh']).optional(),
    schema_behavior: schemaBehaviorSchema.optional(),
    table: nonEmptyString.optional(),
    table_ownership_marker: nonEmptyString.max(256).optional(),
    table_prefix: z.string().max(MAX_STRING_LENGTH).optional(),
  })
  .strict();
const resourceMetadataSchema = z
  .object({
    replication: replicationSchema.optional(),
    load: loadSchema.optional(),
    for_each_parent: nonEmptyString.optional(),
    input_matrix: z
      .object({
        axes: z.record(
          nonEmptyString,
          z
            .array(z.union([z.string(), z.number(), z.boolean()]))
            .min(1)
            .max(MAX_COLLECTION_ITEMS)
        ),
        concurrency: z.number().int().min(1).max(64),
      })
      .strict()
      .optional(),
  })
  .strict();
const resourceMetadataMapSchema = z
  .record(nonEmptyString, resourceMetadataSchema)
  .refine((metadata) => Object.keys(metadata).length <= MAX_COLLECTION_ITEMS, {
    message: `Resource metadata cannot exceed ${MAX_COLLECTION_ITEMS} entries.`,
  });

const currentCommandContractSchema = z
  .object({
    default_command: z.literal('bobsled'),
    command_env: z.literal('BOBSLED_CORE_PIPELINE_COMMAND'),
    cwd_env: z.literal('BOBSLED_CORE_PIPELINE_CWD'),
    timeout_seconds_env: z.literal('BOBSLED_CORE_PIPELINE_TIMEOUT_SECONDS'),
    default_timeout_seconds: z.literal(1800),
    output: z.literal('jsonl'),
  })
  .strict();

const resourceNodeBaseSchema = z
  .object({
    id: nonEmptyString,
    kind: z.literal('bobsled.runner.run_resource'),
    pipeline: nonEmptyString,
    integration: nonEmptyString,
    resource: nonEmptyString,
    resources: z.array(nonEmptyString).min(1).max(MAX_COLLECTION_ITEMS).optional(),
    command: commandSchema,
    emits: z.tuple([z.literal('resource_runs')]),
    replication: replicationSchema.optional(),
    load: loadSchema.optional(),
  })
  .strict();
const embeddedModelNodeSchema = z
  .object({
    id: z.literal('model'),
    kind: z.literal('bobsled.model.run'),
    integration: nonEmptyString,
    models: z.array(nonEmptyString).min(1).max(MAX_COLLECTION_ITEMS),
    command: commandSchema,
    observes: z.tuple([z.literal('resource_runs')]),
    emits: z.tuple([z.literal('model_runs')]),
  })
  .strict();

const resourceNodeSchema = resourceNodeBaseSchema
  .omit({ resources: true })
  .extend({
    resources: z.array(nonEmptyString).min(1).max(MAX_COLLECTION_ITEMS),
  })
  .strict();
const extractNodesSchema = z.union([resourceNodeSchema, embeddedModelNodeSchema]);
const modelNodeSchema = z
  .object({
    id: nonEmptyString,
    kind: z.literal('bobsled.model.run'),
    model: nonEmptyString,
    tags: z.array(nonEmptyString).max(MAX_COLLECTION_ITEMS).optional(),
    command: commandSchema,
    emits: z.tuple([z.literal('model_runs')]),
  })
  .strict();
const entityGraphPhaseSchema = z.enum([
  'resolve',
  'cluster',
  'profile',
  'extract_mentions',
  'extract_relationships',
]);
const entityGraphNodeSchema = z
  .object({
    id: nonEmptyString,
    kind: z.literal('bobsled.entity_graph.run'),
    phase: entityGraphPhaseSchema,
    command: commandSchema,
    emits: z.tuple([z.literal('entity_graph_runs')]),
  })
  .strict();

const extractStateSchema = z
  .object({
    resource_runs: z.literal('append'),
    model_runs: z.literal('append'),
    errors: z.literal('append'),
  })
  .strict();
const modelStateSchema = z
  .object({
    model_runs: z.literal('append'),
    errors: z.literal('append'),
  })
  .strict();
const entityGraphStateSchema = z
  .object({
    entity_graph_runs: z.literal('append'),
    errors: z.literal('append'),
  })
  .strict();
const reverseEtlStateSchema = z
  .object({
    sync_runs: z.literal('append'),
    sync_receipts: z.literal('append'),
    errors: z.literal('append'),
  })
  .strict();

const pipelineCommonFields = {
  name: nonEmptyString,
  description: nonEmptyString.optional(),
  graph_id: nonEmptyString,
  schedule: scheduleSchema,
  trigger: triggerSchema,
};
const extractPipelineBaseSchema = z
  .object({
    ...pipelineCommonFields,
    kind: z.literal('extract'),
    integration: nonEmptyString,
    state: extractStateSchema,
    resource_metadata: resourceMetadataMapSchema.optional(),
    nodes: z.array(extractNodesSchema).min(1).max(MAX_COLLECTION_ITEMS),
    edges: z.array(edgeSchema).min(1).max(MAX_GRAPH_EDGES),
  })
  .strict();
const modelPipelineBaseSchema = z
  .object({
    ...pipelineCommonFields,
    kind: z.literal('models'),
    connection: nonEmptyString,
    models: z.array(nonEmptyString).min(1).max(MAX_COLLECTION_ITEMS),
    synthetic: z.literal(true).optional(),
    state: modelStateSchema,
    nodes: z.array(modelNodeSchema).min(1).max(MAX_COLLECTION_ITEMS),
    edges: z.array(edgeSchema).min(1).max(MAX_GRAPH_EDGES),
  })
  .strict();
const extractPipelineWarehouseSchema = extractPipelineBaseSchema
  .extend({ warehouse: nonEmptyString.optional() })
  .strict();
const modelPipelineSchema = modelPipelineBaseSchema
  .extend({ warehouse: nonEmptyString.optional() })
  .strict();
const extractPipelineSchema = extractPipelineWarehouseSchema
  .extend({ destination_warehouse: nonEmptyString.optional() })
  .strict();
const entityGraphPipelineSchema = z
  .object({
    ...pipelineCommonFields,
    kind: z.literal('entity-graph'),
    connection: nonEmptyString,
    entities: z.union([z.literal('*'), z.array(nonEmptyString).min(1).max(MAX_COLLECTION_ITEMS)]),
    phases: z.array(entityGraphPhaseSchema).min(1).max(MAX_COLLECTION_ITEMS),
    state: entityGraphStateSchema,
    nodes: z.array(entityGraphNodeSchema).min(1).max(MAX_COLLECTION_ITEMS),
    edges: z.array(edgeSchema).min(1).max(MAX_GRAPH_EDGES),
  })
  .strict();
const reverseEtlPipelineSchema = z
  .object({
    ...pipelineCommonFields,
    kind: z.literal('reverse-etl'),
    sync_name: nonEmptyString,
    source_connection: nonEmptyString,
    destination_connection: nonEmptyString.optional(),
    target_action: nonEmptyString,
    state: reverseEtlStateSchema,
    command: commandSchema,
  })
  .strict();

const manifestV7Schema = z
  .object({
    kind: z.literal('bobsled.pipeline.dag'),
    version: z.literal(7),
    bobsled_cli_version: nonEmptyString,
    command_contract: currentCommandContractSchema,
    pipelines: z
      .array(
        z.discriminatedUnion('kind', [
          extractPipelineSchema,
          modelPipelineSchema,
          entityGraphPipelineSchema,
          reverseEtlPipelineSchema,
        ])
      )
      .max(MAX_COLLECTION_ITEMS),
  })
  .strict();

export const PipelineManifestSchema = manifestV7Schema;

export type ValidatedBobsledPipelineManifest = z.infer<typeof PipelineManifestSchema>;

export type ValidatedBobsledPipelineManifestV7 = z.infer<typeof manifestV7Schema>;

export type PipelineManifestValidationIssueCode =
  | 'invalid_manifest'
  | 'unsupported_version'
  | 'duplicate_pipeline_name'
  | 'duplicate_graph_id'
  | 'duplicate_node_id'
  | 'reserved_node_id'
  | 'duplicate_edge'
  | 'invalid_edge_endpoint'
  | 'invalid_edge_direction'
  | 'cyclic_graph'
  | 'unreachable_node'
  | 'command_contract_mismatch'
  | 'schedule_contract_mismatch'
  | 'schedule_trigger_mismatch';

export interface PipelineManifestValidationIssue {
  code: PipelineManifestValidationIssueCode;
  path: string;
  message: string;
}

export type SafeParsePipelineManifestResult =
  | { success: true; data: ValidatedBobsledPipelineManifest }
  | { success: false; issues: PipelineManifestValidationIssue[] };

export class PipelineManifestValidationError extends Error {
  readonly issues: PipelineManifestValidationIssue[];

  constructor(issues: PipelineManifestValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
    this.name = 'PipelineManifestValidationError';
    this.issues = issues;
  }
}

function issuePath(path: PropertyKey[]): string {
  let result = '$';
  for (const segment of path) {
    result += typeof segment === 'number' ? `[${segment}]` : `.${String(segment)}`;
  }
  return result;
}

function structuralIssues(error: z.ZodError): PipelineManifestValidationIssue[] {
  return error.issues.map((issue) => ({
    code:
      issue.path.length === 1 && issue.path[0] === 'version'
        ? 'unsupported_version'
        : 'invalid_manifest',
    path: issuePath(issue.path),
    message: issue.message,
  }));
}

interface DagLikePipeline {
  name: string;
  graph_id: string;
  schedule: { expression: string; cron: string };
  trigger?: 'schedule' | 'manual';
  nodes?: Array<{ id: string }>;
  edges?: Array<{ from: string; to: string }>;
}

const sentinels = new Set(['__start__', '__end__']);

function graphIssues(
  pipeline: DagLikePipeline,
  pipelineIndex: number
): PipelineManifestValidationIssue[] {
  const nodes = pipeline.nodes;
  const edges = pipeline.edges;
  if (!nodes || !edges) return [];

  const issues: PipelineManifestValidationIssue[] = [];
  const base = `$.pipelines[${pipelineIndex}]`;
  const ids = new Set<string>();
  for (let index = 0; index < nodes.length; index += 1) {
    const id = nodes[index]!.id;
    if (sentinels.has(id)) {
      issues.push({
        code: 'reserved_node_id',
        path: `${base}.nodes[${index}].id`,
        message: `Node id "${id}" is reserved for graph boundaries.`,
      });
    }
    if (ids.has(id)) {
      issues.push({
        code: 'duplicate_node_id',
        path: `${base}.nodes[${index}].id`,
        message: `Duplicate node id "${id}".`,
      });
    }
    ids.add(id);
  }

  const edgeKeys = new Set<string>();
  const allIds = new Set([...ids, ...sentinels]);
  const adjacency = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  const indegree = new Map<string, number>([...allIds].map((id) => [id, 0]));
  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index]!;
    const edgePath = `${base}.edges[${index}]`;
    const key = `${edge.from}\u0000${edge.to}`;
    const isDuplicate = edgeKeys.has(key);
    if (isDuplicate) {
      issues.push({
        code: 'duplicate_edge',
        path: edgePath,
        message: `Duplicate edge "${edge.from}" → "${edge.to}".`,
      });
    }
    edgeKeys.add(key);
    if (!allIds.has(edge.from)) {
      issues.push({
        code: 'invalid_edge_endpoint',
        path: `${edgePath}.from`,
        message: `Edge references unknown source node "${edge.from}".`,
      });
    }
    if (!allIds.has(edge.to)) {
      issues.push({
        code: 'invalid_edge_endpoint',
        path: `${edgePath}.to`,
        message: `Edge references unknown target node "${edge.to}".`,
      });
    }
    if (edge.to === '__start__' || edge.from === '__end__') {
      issues.push({
        code: 'invalid_edge_direction',
        path: edgePath,
        message: 'Edges cannot enter __start__ or leave __end__.',
      });
      continue;
    }
    if (!allIds.has(edge.from) || !allIds.has(edge.to)) continue;
    // Report duplicate edges, but do not add them to graph topology twice.
    if (isDuplicate) continue;
    const outgoing = adjacency.get(edge.from);
    if (outgoing) outgoing.push(edge.to);
    else adjacency.set(edge.from, [edge.to]);
    const incoming = reverse.get(edge.to);
    if (incoming) incoming.push(edge.from);
    else reverse.set(edge.to, [edge.from]);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const queue = [...allIds].filter((id) => indegree.get(id) === 0);
  let queueIndex = 0;
  let visitedCount = 0;
  while (queueIndex < queue.length) {
    const current = queue[queueIndex++]!;
    visitedCount += 1;
    for (const next of adjacency.get(current) ?? []) {
      const nextIndegree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, nextIndegree);
      if (nextIndegree === 0) queue.push(next);
    }
  }
  if (visitedCount !== allIds.size) {
    issues.push({
      code: 'cyclic_graph',
      path: `${base}.edges`,
      message: 'Graph contains a cycle.',
    });
  }

  const reachable = (start: string, graph: Map<string, string[]>): Set<string> => {
    const seen = new Set<string>([start]);
    const stack = [start];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const next of graph.get(current) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    return seen;
  };
  const fromStart = reachable('__start__', adjacency);
  const toEnd = reachable('__end__', reverse);
  for (let index = 0; index < nodes.length; index += 1) {
    const id = nodes[index]!.id;
    if (!fromStart.has(id) || !toEnd.has(id)) {
      issues.push({
        code: 'unreachable_node',
        path: `${base}.nodes[${index}].id`,
        message: `Node "${id}" must be reachable from __start__ and able to reach __end__.`,
      });
    }
  }
  return issues;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

const ENTITY_GRAPH_COMMAND_PREFIXES: Record<string, string[]> = {
  resolve: ['entity-graph', 'resolve', 'run'],
  cluster: ['entity-graph', 'resolve', 'cluster'],
  profile: ['entity-graph', 'resolve', 'profile'],
  extract_mentions: ['entity-graph', 'mentions', 'extract'],
  extract_relationships: ['entity-graph', 'relationships', 'extract'],
};

function commandIssues(
  pipeline: ValidatedBobsledPipelineManifest['pipelines'][number],
  pipelineIndex: number
): PipelineManifestValidationIssue[] {
  const issues: PipelineManifestValidationIssue[] = [];
  const mismatch = (path: string, message: string): void => {
    issues.push({ code: 'command_contract_mismatch', path, message });
  };
  if (pipeline.kind === 'models') {
    for (const [nodeIndex, node] of pipeline.nodes.entries()) {
      const expected = ['model', 'run', node.model, '--integration', pipeline.connection, '--json'];
      if (!arraysEqual(node.command, expected)) {
        mismatch(
          `$.pipelines[${pipelineIndex}].nodes[${nodeIndex}].command`,
          `Model node command must execute its declared model "${node.model}".`
        );
      }
    }
  }

  if (pipeline.kind === 'extract') {
    for (const [nodeIndex, node] of pipeline.nodes.entries()) {
      let expected: string[];
      if (node.kind === 'bobsled.model.run') {
        expected = ['model', 'run', ...node.models, '--integration', node.integration, '--json'];
      } else {
        const resources = node.resources ?? [node.resource];
        expected = ['runner', 'run', node.pipeline, '--resource', ...resources, '--json'];
      }
      if (!arraysEqual(node.command, expected)) {
        mismatch(
          `$.pipelines[${pipelineIndex}].nodes[${nodeIndex}].command`,
          'Extract node command must execute its declared pipeline and resources.'
        );
      }
    }
  }

  if (pipeline.kind === 'entity-graph') {
    const entityArgs = pipeline.entities === '*' ? [] : pipeline.entities;
    for (const [nodeIndex, node] of pipeline.nodes.entries()) {
      const prefix = ENTITY_GRAPH_COMMAND_PREFIXES[node.phase] ?? [];
      const withoutIncremental = [...prefix, ...entityArgs, '--json'];
      const withIncremental = [...prefix, ...entityArgs, '--incremental', '--json'];
      const valid =
        arraysEqual(node.command, withoutIncremental) ||
        (node.phase === 'resolve' && arraysEqual(node.command, withIncremental));
      if (!valid) {
        mismatch(
          `$.pipelines[${pipelineIndex}].nodes[${nodeIndex}].command`,
          `Entity-graph node command must execute its declared "${node.phase}" phase.`
        );
      }
    }
  }

  if ('kind' in pipeline && pipeline.kind === 'reverse-etl') {
    const expected = ['sync', 'run', pipeline.sync_name, '--json'];
    if (!arraysEqual(pipeline.command, expected)) {
      mismatch(
        `$.pipelines[${pipelineIndex}].command`,
        'Reverse-ETL command must execute its declared sync.'
      );
    }
  }
  return issues;
}

function semanticIssues(
  manifest: ValidatedBobsledPipelineManifest
): PipelineManifestValidationIssue[] {
  const issues: PipelineManifestValidationIssue[] = [];
  const names = new Set<string>();
  const graphIds = new Set<string>();
  for (let index = 0; index < manifest.pipelines.length; index += 1) {
    const pipeline = manifest.pipelines[index]!;
    const base = `$.pipelines[${index}]`;
    if (names.has(pipeline.name)) {
      issues.push({
        code: 'duplicate_pipeline_name',
        path: `${base}.name`,
        message: `Duplicate pipeline name "${pipeline.name}".`,
      });
    }
    names.add(pipeline.name);
    if (graphIds.has(pipeline.graph_id)) {
      issues.push({
        code: 'duplicate_graph_id',
        path: `${base}.graph_id`,
        message: `Duplicate graph id "${pipeline.graph_id}".`,
      });
    }
    graphIds.add(pipeline.graph_id);

    const cronIsManual = pipeline.schedule.cron === 'manual';
    const expressionIsManual = pipeline.schedule.expression === 'manual';
    const isManual =
      'trigger' in pipeline ? pipeline.trigger === 'manual' : cronIsManual && expressionIsManual;
    if (
      (isManual && (!cronIsManual || !expressionIsManual)) ||
      (!isManual && (cronIsManual || expressionIsManual))
    ) {
      issues.push({
        code: 'schedule_trigger_mismatch',
        path: `${base}.schedule`,
        message:
          'Manual pipelines must use the "manual" schedule sentinel; scheduled pipelines must use a cron schedule.',
      });
    }
    if (!isManual) {
      try {
        const expectedCron = parseToCron(pipeline.schedule.expression);
        if (pipeline.schedule.cron !== expectedCron) {
          issues.push({
            code: 'schedule_contract_mismatch',
            path: `${base}.schedule.cron`,
            message: `Cron does not match schedule expression; expected "${expectedCron}".`,
          });
        }
      } catch {
        issues.push({
          code: 'schedule_contract_mismatch',
          path: `${base}.schedule.expression`,
          message: 'Schedule expression is not supported by Bobsled Core.',
        });
      }
    }
    issues.push(...commandIssues(pipeline, index));
    issues.push(...graphIssues(pipeline, index));
  }
  return issues;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function arrayLimitIssue(
  value: unknown,
  max: number,
  path: string
): PipelineManifestValidationIssue | undefined {
  if (!Array.isArray(value) || value.length <= max) return undefined;
  return {
    code: 'invalid_manifest',
    path,
    message: `Too big: expected array to have <=${max} items`,
  };
}

function entryLimitIssue(
  value: unknown,
  path: string,
  label: string
): PipelineManifestValidationIssue | undefined {
  if (!isPlainRecord(value) || Object.keys(value).length <= MAX_COLLECTION_ITEMS) return undefined;
  return {
    code: 'invalid_manifest',
    path,
    message: `${label} cannot exceed ${MAX_COLLECTION_ITEMS} entries.`,
  };
}

function loadLimitIssue(load: unknown, path: string): PipelineManifestValidationIssue | undefined {
  if (!isPlainRecord(load)) return undefined;
  return entryLimitIssue(
    load['destination_settings'],
    `${path}.destination_settings`,
    'Destination settings'
  );
}

function resourceMetadataLimitIssue(
  metadata: unknown,
  path: string
): PipelineManifestValidationIssue | undefined {
  const mapIssue = entryLimitIssue(metadata, path, 'Resource metadata');
  if (mapIssue || !isPlainRecord(metadata)) return mapIssue;
  for (const [resource, entry] of Object.entries(metadata)) {
    if (!isPlainRecord(entry)) continue;
    const entryPath = `${path}.${resource}`;
    const loadIssue = loadLimitIssue(entry['load'], `${entryPath}.load`);
    if (loadIssue) return loadIssue;
    const matrix = entry['input_matrix'];
    if (!isPlainRecord(matrix) || !isPlainRecord(matrix['axes'])) continue;
    for (const [axis, values] of Object.entries(matrix['axes'])) {
      const issue = arrayLimitIssue(
        values,
        MAX_COLLECTION_ITEMS,
        `${entryPath}.input_matrix.axes.${axis}`
      );
      if (issue) return issue;
    }
  }
  return undefined;
}

const PIPELINE_ARRAY_LIMITS: ReadonlyArray<readonly [string, number]> = [
  ['nodes', MAX_COLLECTION_ITEMS],
  ['edges', MAX_GRAPH_EDGES],
  ['models', MAX_COLLECTION_ITEMS],
  ['entities', MAX_COLLECTION_ITEMS],
  ['phases', MAX_COLLECTION_ITEMS],
  ['command', MAX_COMMAND_TOKENS],
];
const NODE_ARRAY_LIMITS: ReadonlyArray<readonly [string, number]> = [
  ['resources', MAX_COLLECTION_ITEMS],
  ['models', MAX_COLLECTION_ITEMS],
  ['tags', MAX_COLLECTION_ITEMS],
  ['command', MAX_COMMAND_TOKENS],
];

function fieldLimitIssue(
  record: Record<string, unknown>,
  limits: ReadonlyArray<readonly [string, number]>,
  path: string
): PipelineManifestValidationIssue | undefined {
  for (const [field, max] of limits) {
    const issue = arrayLimitIssue(record[field], max, `${path}.${field}`);
    if (issue) return issue;
  }
  return undefined;
}

function collectionLimitIssue(input: unknown): PipelineManifestValidationIssue | undefined {
  if (!isPlainRecord(input)) return undefined;
  const pipelines = input['pipelines'];
  const pipelinesIssue = arrayLimitIssue(pipelines, MAX_COLLECTION_ITEMS, '$.pipelines');
  if (pipelinesIssue || !Array.isArray(pipelines)) return pipelinesIssue;
  for (let index = 0; index < pipelines.length; index += 1) {
    const pipeline: unknown = pipelines[index];
    if (!isPlainRecord(pipeline)) continue;
    const base = `$.pipelines[${index}]`;
    const issue =
      fieldLimitIssue(pipeline, PIPELINE_ARRAY_LIMITS, base) ??
      resourceMetadataLimitIssue(pipeline['resource_metadata'], `${base}.resource_metadata`);
    if (issue) return issue;
    const nodes = pipeline['nodes'];
    if (!Array.isArray(nodes)) continue;
    for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
      const node: unknown = nodes[nodeIndex];
      if (!isPlainRecord(node)) continue;
      const nodePath = `${base}.nodes[${nodeIndex}]`;
      const nodeIssue =
        fieldLimitIssue(node, NODE_ARRAY_LIMITS, nodePath) ??
        loadLimitIssue(node['load'], `${nodePath}.load`);
      if (nodeIssue) return nodeIssue;
    }
  }
  return undefined;
}

export function safeParsePipelineManifest(input: unknown): SafeParsePipelineManifestResult {
  const version =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)['version']
      : undefined;
  if (
    typeof version === 'number' &&
    !(PIPELINE_MANIFEST_COMPAT_VERSIONS as readonly number[]).includes(version)
  ) {
    return {
      success: false,
      issues: [
        {
          code: 'unsupported_version',
          path: '$.version',
          message: `Unsupported manifest version ${String(version)}. Compatible versions: ${PIPELINE_MANIFEST_COMPAT_VERSIONS.join(', ')}.`,
        },
      ],
    };
  }

  const limitIssue = collectionLimitIssue(input);
  if (limitIssue) return { success: false, issues: [limitIssue] };

  const parsed = PipelineManifestSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, issues: structuralIssues(parsed.error) };
  }
  const issues = semanticIssues(parsed.data);
  return issues.length > 0 ? { success: false, issues } : { success: true, data: parsed.data };
}

export function parsePipelineManifest(input: unknown): ValidatedBobsledPipelineManifest {
  const result = safeParsePipelineManifest(input);
  if (!result.success) {
    throw new PipelineManifestValidationError(result.issues);
  }
  return result.data;
}
