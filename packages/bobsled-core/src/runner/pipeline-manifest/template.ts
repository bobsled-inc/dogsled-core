import { CommandError } from '@bobsled-inc/protocol';

import type { ModelNode } from '../config/loader.js';

export type PipelineReplicationMethod =
  'full_refresh' | 'incremental_append' | 'incremental_merge' | 'change_tracking';

export type PipelineLoadStrategy = 'append' | 'merge' | 'full_refresh';
export type PipelineSchemaBehavior = 'evolve' | 'strict' | 'freeze';

export interface PipelineResourceLoadMetadata {
  /** Legacy resource-owned destination handle, retained for persisted compatibility. */
  integration?: string;
  /** Resolved pipeline destinations in authored order. */
  destinations?: string[];
  /** Effective settings keyed by destination name. */
  destination_settings?: Record<
    string,
    {
      load_strategy?: PipelineLoadStrategy;
      schema_behavior?: PipelineSchemaBehavior;
      table_prefix?: string;
    }
  >;
  /** Effective resource override, pipeline strategy, or destination fallback. */
  load_strategy?: PipelineLoadStrategy;
  /** Effective resource override, pipeline, or destination schema behavior. */
  schema_behavior?: PipelineSchemaBehavior;
  /** Optional per-resource target table override. */
  table?: string;
  /** Optional Snowflake ownership marker for the exact target table. */
  table_ownership_marker?: string;
  /** Resolved pipeline table prefix. */
  table_prefix?: string;
}

export interface PipelineResourceMetadata {
  replication?: {
    method: PipelineReplicationMethod;
    cursor_field?: string;
  };
  load?: PipelineResourceLoadMetadata;
  /**
   * Name of the resource this one iterates over via `extract.for_each`. The
   * extractor's in-memory for_each cache only sees resources that ran inside
   * the same subprocess, so the manifest builder co-locates each child with
   * its parent (and ancestors) into a single node. Optional — independent
   * resources omit this field.
   */
  for_each_parent?: string;
  /** Static request matrix carried into managed-runner validation and diagnostics. */
  input_matrix?: {
    axes: Record<string, Array<string | number | boolean>>;
    concurrency: number;
  };
}

/**
 * Trigger model carried alongside each pipeline in the pipeline manifest.
 *
 * - `'schedule'`: pipeline fires automatically on its `schedule.cron`. This is
 *   the v1/v2 default; manifest consumers that don't know about `trigger:`
 *   should treat absent values as `'schedule'`.
 * - `'manual'`: pipeline is defined and deployable but has no automatic
 *   trigger. `schedule.cron` is serialized as the sentinel `'manual'` so the
 *   manifest stays structurally identical to scheduled pipelines, but readers
 *   MUST NOT pass that value to a cron scheduler. Use `trigger` as the
 *   discriminator.
 */
export type PipelineTrigger = 'schedule' | 'manual';

/** Sentinel value used in `schedule.cron` / `schedule.expression` for manual pipelines. */
export const MANUAL_SCHEDULE_SENTINEL = 'manual' as const;

export interface PipelineTemplateInput {
  /** POSIX cron expression, or `null` for manual-trigger pipelines. */
  cron: string | null;
  graphId: string;
  integration: string;
  /** Optional session warehouse selected for this pipeline's execution. */
  warehouse?: string;
  /** Stable managed destination warehouse ID selected by the author. */
  destinationWarehouse?: string;
  modelSequence: string[];
  pipelineName: string;
  description?: string;
  resources: string[];
  resourceMetadata?: Record<string, PipelineResourceMetadata>;
  runModels: boolean;
  schedule: string;
  trigger: PipelineTrigger;
}

/**
 * Input describing a `kind: 'models'` pipeline (authored or synthetic). The
 * host application reads these out of the manifest to decide which `dogsled model run
 * <models...>` invocation to schedule per cron tick.
 */
export interface ModelPipelineTemplateInput {
  pipelineName: string;
  description?: string;
  graphId: string;
  connection: string;
  /** Optional session warehouse selected for this pipeline's execution. */
  warehouse?: string;
  models: string[];
  /**
   * Per-model nodes (name + in-pipeline refs + tags) used to build the v3
   * task DAG. Parallel to `models`, same order; refs are already intersected
   * with this pipeline's model set.
   */
  modelNodes: ModelNode[];
  schedule: string;
  /** POSIX cron expression, or `null` for manual-trigger pipelines. */
  cron: string | null;
  trigger: PipelineTrigger;
  /** True only for `_models_default_<connection>` pipelines emitted by the parser. */
  synthetic: boolean;
}

/** Runtime phase carried alongside each entity-graph pipeline in the manifest. */
export type EntityGraphPhase =
  'resolve' | 'cluster' | 'profile' | 'extract_mentions' | 'extract_relationships';

/**
 * Input describing a `kind: 'entity-graph'` pipeline. Each cron tick the
 * host application's pipeline adapter iterates `phases` in order and invokes
 * `@bobsled-inc/entity-graph/api`'s `runResolveProject` / `clusterResolveProject`
 * with the named entities against `connection`. Wildcard `entities` is
 * preserved here and expanded at run time against the project's
 * resolution-spec inventory.
 */
export interface EntityGraphPipelineTemplateInput {
  pipelineName: string;
  description?: string;
  graphId: string;
  connection: string;
  /** `'*'` means "every resolution spec in entity-graph/"; expanded at run time. */
  entities: '*' | string[];
  phases: EntityGraphPhase[];
  /** Scheduled resolve runs default to incremental; manual runs stay full. */
  defaultRunMode?: 'full' | 'incremental';
  schedule: string;
  /** POSIX cron expression, or `null` for manual-trigger pipelines. */
  cron: string | null;
  trigger: PipelineTrigger;
}

/**
 * Input describing a `kind: 'reverse-etl'` pipeline sourced from `syncs/*.yml`.
 * Each manifest tick invokes `dogsled sync run <sync_name> --json`; the sync spec
 * owns the source projection, action reference, entity key, and input mapping.
 */
export interface ReverseEtlPipelineTemplateInput {
  pipelineName: string;
  description?: string;
  graphId: string;
  syncName: string;
  sourceConnection: string;
  destinationConnection?: string;
  targetAction: string;
  schedule: string;
  /** POSIX cron expression, or `null` for manual-trigger syncs. */
  cron: string | null;
  trigger: PipelineTrigger;
}

export const PIPELINE_MANIFEST_VERSION = 7 as const;

export const PIPELINE_MANIFEST_COMPAT_VERSIONS = [7] as const;
export type PipelineManifestVersion = (typeof PIPELINE_MANIFEST_COMPAT_VERSIONS)[number];

export interface BobsledPipelineManifest {
  kind: 'dogsled.pipeline.dag';
  version: typeof PIPELINE_MANIFEST_VERSION;
  dogsled_cli_version: string;
  command_contract: PipelineCommandContract;
  pipelines: BobsledPipelineEntry[];
}

export interface PipelineCommandContract {
  default_command: 'dogsled';
  command_env: 'BOBSLED_CORE_PIPELINE_COMMAND';
  cwd_env: 'BOBSLED_CORE_PIPELINE_CWD';
  timeout_seconds_env: 'BOBSLED_CORE_PIPELINE_TIMEOUT_SECONDS';
  default_timeout_seconds: 1800;
  output: 'jsonl';
}

export type BobsledPipelineEntry =
  | ExtractPipelineManifest
  | ModelPipelineManifest
  | EntityGraphPipelineManifest
  | ReverseEtlPipelineManifest;

interface PipelineCommonFields {
  name: string;
  description?: string;
  graph_id: string;
  schedule: {
    expression: string;
    cron: string;
  };
  /**
   * Trigger model — `'schedule'` means `schedule.cron` is a real POSIX cron
   * expression and the runtime should register it. `'manual'` means there is
   * no cron; `schedule.cron` is serialized as the literal `'manual'` sentinel
   * and the runtime MUST NOT pass it to a cron scheduler. Readers that don't
   * know about this field should treat its absence as `'schedule'` for
   * backwards compatibility with manifest v1 / v2-without-manual configs.
   */
  trigger: PipelineTrigger;
}

export interface ExtractPipelineManifest extends PipelineCommonFields {
  kind: 'extract';
  integration: string;
  /** Optional session warehouse selector for a programmatic execution host. */
  warehouse?: string;
  /** Stable managed destination warehouse ID for the execution host. */
  destination_warehouse?: string;
  state: {
    resource_runs: 'append';
    model_runs: 'append';
    errors: 'append';
  };
  /** Complete resolved metadata keyed by every resource executed by the pipeline. */
  resource_metadata?: Record<string, PipelineResourceMetadata>;
  nodes: PipelineManifestNode[];
  edges: PipelineManifestEdge[];
}

/**
 * v3 model-pipeline manifest entry — a uniform task DAG: one `nodes[]` entry
 * per model (each carrying its own `model run <name>` command, which under the
 * v3 exact-selection default runs exactly that model) plus `edges[]` derived
 * from each model's in-pipeline `ref`s. Structurally disjoint from the v2 shape
 * (`ModelPipelineManifestV2`): v3 carries `nodes`/`edges` and NO batch
 * `command`, so a reader branches purely on the manifest `version`.
 */
export interface ModelPipelineManifest extends PipelineCommonFields {
  kind: 'models';
  connection: string;
  /** Optional session warehouse selector for a programmatic execution host. */
  warehouse?: string;
  models: string[];
  /** Present and `true` only for synthetic `_models_default_<connection>` entries. */
  synthetic?: true;
  state: {
    model_runs: 'append';
    errors: 'append';
  };
  nodes: ModelDagNode[];
  edges: PipelineManifestEdge[];
}

/**
 * v3 manifest entry for a `kind: 'entity-graph'` pipeline — a uniform task DAG:
 * one `nodes[]` entry per phase (each carrying the same verbatim per-phase
 * `entity-graph resolve <phase>` command v2 baked into `commands[]`) plus
 * sequential `edges[]` (`__start__ → phase₀ → … → __end__`). Wildcard
 * `entities` rides through unchanged — the adapter expands it against the
 * resolution-spec inventory immediately before invocation. Structurally
 * disjoint from the v2 shape (`...V2`); readers branch on the manifest
 * `version`.
 */
export interface EntityGraphPipelineManifest extends PipelineCommonFields {
  kind: 'entity-graph';
  connection: string;
  entities: '*' | string[];
  phases: EntityGraphPhase[];
  state: {
    entity_graph_runs: 'append';
    errors: 'append';
  };
  nodes: EntityGraphNode[];
  edges: PipelineManifestEdge[];
}

/**
 * Manifest entry for a `kind: 'reverse-etl'` pipeline. The adapter can run the
 * command verbatim; app-managed connection metadata is carried separately when
 * present on the sync target.
 */
export interface ReverseEtlPipelineManifest extends PipelineCommonFields {
  kind: 'reverse-etl';
  sync_name: string;
  source_connection: string;
  destination_connection?: string;
  target_action: string;
  state: {
    sync_runs: 'append';
    sync_receipts: 'append';
    errors: 'append';
  };
  command: string[];
}

type PipelineManifestNode = ExtractNode | EmbeddedModelNode;

/**
 * v3 per-model node for a standalone `kind: 'models'` pipeline. One model per
 * node; `command` runs exactly that model (the v3 exact-selection default).
 * Distinct from the embedded post-extract `EmbeddedModelNode` (which batches
 * `models[]` for the `models.after` feature).
 */
export interface ModelDagNode {
  /** `model_<lowercased model name>` — unique within the pipeline. */
  id: string;
  kind: 'dogsled.model.run';
  /** Model name, authored case (matches the `command` argument). */
  model: string;
  /** Selector metadata carried through for `tag:` selection. Omitted when empty. */
  tags?: string[];
  command: string[];
  emits: readonly ['model_runs'];
}

/** v3 per-phase node for a `kind: 'entity-graph'` pipeline. */
export interface EntityGraphNode {
  /** `phase_<phase>` — unique within the pipeline. */
  id: string;
  kind: 'dogsled.entity_graph.run';
  phase: EntityGraphPhase;
  command: string[];
  emits: readonly ['entity_graph_runs'];
}

interface ExtractNode {
  id: string;
  kind: 'dogsled.runner.run_resource';
  pipeline: string;
  integration: string;
  /**
   * Primary resource for this node — the root of the for_each chain when the
   * node groups multiple coupled resources, or the sole resource for an
   * independent node. Kept for adapter observability and existing consumers
   * that label nodes by a single resource name.
   */
  resource: string;
  /**
   * All resources executed inside this node's subprocess, in topological
   * for_each order (parents before children). Independent nodes have a
   * single-element array equal to `[resource]`. Adapters that exec `command`
   * verbatim do not need to consult this field.
   */
  resources: string[];
  command: string[];
  emits: readonly ['resource_runs'];
  replication?: {
    method: PipelineReplicationMethod;
    cursor_field?: string;
  };
  load?: PipelineResourceLoadMetadata;
}

interface EmbeddedModelNode {
  id: 'model';
  kind: 'dogsled.model.run';
  integration: string;
  models: string[];
  command: string[];
  observes: readonly ['resource_runs'];
  emits: readonly ['model_runs'];
}

interface PipelineManifestEdge {
  from: string;
  to: string;
}

export const PIPELINE_MANIFEST_PATH = 'dogsled.pipeline.dag.json';

function safeNodeToken(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'resource';
}

function nodeIdForResource(index: number, resource: string): string {
  return `extract_${index}_${safeNodeToken(resource)}`;
}

function buildExtractNode(
  input: PipelineTemplateInput,
  resources: string[],
  index: number
): ExtractNode {
  // First resource in `resources` is the topologically-first one (a parent
  // when the node groups a for_each chain). Use it for the node id and the
  // `resource` observability label.
  const primary = resources[0]!;
  const node: ExtractNode = {
    id: nodeIdForResource(index, primary),
    kind: 'dogsled.runner.run_resource',
    pipeline: input.pipelineName,
    integration: input.integration,
    resource: primary,
    resources,
    command: ['runner', 'run', input.pipelineName, '--resource', ...resources, '--json'],
    emits: ['resource_runs'] as const,
  };

  // Retain the legacy primary-resource shortcuts for existing consumers.
  // Complete metadata is emitted once at pipeline level below.
  const meta = input.resourceMetadata?.[primary];
  if (meta?.replication) {
    node.replication = meta.replication;
  }
  if (meta?.load) {
    const legacyLoad = {
      ...(meta.load.integration ? { integration: meta.load.integration } : {}),
      ...(meta.load.load_strategy ? { load_strategy: meta.load.load_strategy } : {}),
      ...(meta.load.schema_behavior ? { schema_behavior: meta.load.schema_behavior } : {}),
    };
    if (Object.keys(legacyLoad).length > 0) {
      node.load = legacyLoad;
    }
  }
  return node;
}

/**
 * Group resources into connected components using `for_each_parent` edges.
 * Each component runs inside one subprocess so the extractor's in-memory
 * `forEachCache` (`packages/extractor/src/commands/extract.ts`) is populated
 * by the parent before the child reads it.
 *
 * Returns groups in stable order — each group's first element is its
 * topologically-earliest resource (a root, or the resource declared earliest
 * in the input list when ties exist), and group order follows the position
 * of each root in `resources`.
 *
 * Edges to parents that aren't in `resources` are ignored: the child will
 * still warn at run time about the missing parent, but it stays its own node
 * instead of getting fused with an unrelated group.
 */
function groupResourcesByForEach(
  resources: string[],
  metadata: Record<string, PipelineResourceMetadata> | undefined
): string[][] {
  if (resources.length === 0) {
    return [];
  }

  const indexOf = new Map<string, number>(resources.map((name, i) => [name, i]));
  const parent = new Map<string, string>();

  const find = (name: string): string => {
    let cursor = name;
    while (parent.get(cursor) && parent.get(cursor) !== cursor) {
      const next = parent.get(cursor)!;
      parent.set(cursor, parent.get(next) ?? next);
      cursor = parent.get(cursor)!;
    }
    return cursor;
  };

  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;
    // Prefer the resource declared earliest in `resources` as the component
    // root — it tends to be the for_each parent and gives us stable ordering.
    const idxA = indexOf.get(rootA) ?? Number.MAX_SAFE_INTEGER;
    const idxB = indexOf.get(rootB) ?? Number.MAX_SAFE_INTEGER;
    if (idxA <= idxB) {
      parent.set(rootB, rootA);
    } else {
      parent.set(rootA, rootB);
    }
  };

  for (const name of resources) {
    parent.set(name, name);
  }

  // Track parent-of-child edges so we can topologically sort within a group.
  const parentOf = new Map<string, string>();
  for (const name of resources) {
    const meta = metadata?.[name];
    const forEachParent = meta?.for_each_parent;
    if (!forEachParent || !indexOf.has(forEachParent)) {
      continue;
    }
    parentOf.set(name, forEachParent);
    union(name, forEachParent);
  }

  // Bucket members by component root, preserving original declaration order.
  const buckets = new Map<string, string[]>();
  for (const name of resources) {
    const root = find(name);
    const bucket = buckets.get(root) ?? [];
    bucket.push(name);
    buckets.set(root, bucket);
  }

  // Topologically sort each bucket: parents before children. We do this with
  // Kahn's algorithm restricted to in-bucket edges so the in-bucket ordering
  // is deterministic regardless of declared order.
  const sortedBuckets: string[][] = [];
  // Iterate buckets in the order their root resources appear in `resources`.
  for (const root of resources) {
    const bucket = buckets.get(root);
    if (!bucket) continue;
    sortedBuckets.push(topoSortBucket(bucket, parentOf, indexOf));
    buckets.delete(root);
  }
  return sortedBuckets;
}

function topoSortBucket(
  bucket: string[],
  parentOf: Map<string, string>,
  indexOf: Map<string, number>
): string[] {
  const memberSet = new Set(bucket);
  const indegree = new Map<string, number>(bucket.map((name) => [name, 0]));
  const childrenByParent = new Map<string, string[]>();

  for (const name of bucket) {
    const p = parentOf.get(name);
    if (!p || !memberSet.has(p)) continue;
    indegree.set(name, (indegree.get(name) ?? 0) + 1);
    const children = childrenByParent.get(p) ?? [];
    children.push(name);
    childrenByParent.set(p, children);
  }

  const compareByDeclaredOrder = (a: string, b: string): number =>
    (indexOf.get(a) ?? Number.MAX_SAFE_INTEGER) - (indexOf.get(b) ?? Number.MAX_SAFE_INTEGER);

  const ready = bucket.filter((name) => (indegree.get(name) ?? 0) === 0);
  ready.sort(compareByDeclaredOrder);
  const ordered: string[] = [];

  while (ready.length > 0) {
    const next = ready.shift()!;
    ordered.push(next);
    const children = (childrenByParent.get(next) ?? []).slice().sort(compareByDeclaredOrder);
    for (const child of children) {
      const remaining = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, remaining);
      if (remaining === 0) {
        ready.push(child);
        ready.sort(compareByDeclaredOrder);
      }
    }
  }

  // Cycle fallback (shouldn't happen — for_each is a DAG by construction).
  // Preserve declared order rather than drop members.
  if (ordered.length !== bucket.length) {
    return bucket.slice().sort(compareByDeclaredOrder);
  }
  return ordered;
}

function buildModelNode(input: PipelineTemplateInput): EmbeddedModelNode {
  return {
    id: 'model',
    kind: 'dogsled.model.run',
    integration: input.integration,
    models: input.modelSequence,
    command: ['model', 'run', ...input.modelSequence, '--integration', input.integration, '--json'],
    observes: ['resource_runs'],
    emits: ['model_runs'],
  };
}

function buildExtractPipelineManifest(input: PipelineTemplateInput): ExtractPipelineManifest {
  // Group resources by for_each connected component so each group runs in a
  // single subprocess. This is the load-bearing fix for the pipeline runner:
  // sibling nodes can't see each other's in-memory `forEachCache`, so any
  // child resource that uses `extract.for_each` must run in the same process
  // as its parent.
  const groups = groupResourcesByForEach(input.resources, input.resourceMetadata);
  const extractNodes = groups.map((group, index) => buildExtractNode(input, group, index));
  const nodes: PipelineManifestNode[] = input.runModels
    ? [...extractNodes, buildModelNode(input)]
    : extractNodes;
  const edges: PipelineManifestEdge[] = [];

  for (const node of extractNodes) {
    edges.push({ from: '__start__', to: node.id });
    edges.push({ from: node.id, to: input.runModels ? 'model' : '__end__' });
  }

  if (input.runModels) {
    edges.push({ from: 'model', to: '__end__' });
  }

  const manifest: ExtractPipelineManifest = {
    name: input.pipelineName,
    kind: 'extract',
    integration: input.integration,
    ...(input.warehouse !== undefined ? { warehouse: input.warehouse } : {}),
    ...(input.destinationWarehouse !== undefined
      ? { destination_warehouse: input.destinationWarehouse }
      : {}),
    graph_id: input.graphId,
    schedule: {
      expression: input.schedule,
      cron: input.cron ?? MANUAL_SCHEDULE_SENTINEL,
    },
    trigger: input.trigger,
    state: {
      resource_runs: 'append',
      model_runs: 'append',
      errors: 'append',
    },
    ...(input.resourceMetadata ? { resource_metadata: input.resourceMetadata } : {}),
    nodes,
    edges,
  };
  if (input.description !== undefined) {
    manifest.description = input.description;
  }
  return manifest;
}

/** Stable, collision-checked node id for a v3 model node. */
function modelNodeId(name: string): string {
  return `model_${name.toLowerCase()}`;
}

/**
 * Build the v3 model-DAG edges from the per-model `ref`s. Refs are already
 * intersected with the pipeline's model set (in `buildModelNodes`), so every
 * ref names another node here. Matching is case-insensitive (lowercased on both
 * sides), mirroring the Model Spec DAG. A model with no in-pipeline refs is a root
 * (`__start__ → id`); a model that no other in-pipeline model refs is a leaf
 * (`id → __end__`); an isolated single node is both.
 */
function buildModelDagEdges(modelNodes: ModelNode[]): PipelineManifestEdge[] {
  const idByCanonical = new Map<string, string>();
  for (const node of modelNodes) {
    idByCanonical.set(node.name.toLowerCase(), modelNodeId(node.name));
  }

  const edges: PipelineManifestEdge[] = [];
  const referenced = new Set<string>();

  // Incoming edges first, in node order: either `__start__ → id` (root) or one
  // `ref → id` per in-pipeline upstream.
  for (const node of modelNodes) {
    const id = modelNodeId(node.name);
    const self = node.name.toLowerCase();
    const keptRefs = [
      ...new Set(node.refs.map((ref) => ref.toLowerCase()).filter((ref) => ref !== self)),
    ].filter((ref) => idByCanonical.has(ref));
    if (keptRefs.length === 0) {
      edges.push({ from: '__start__', to: id });
    } else {
      for (const ref of keptRefs) {
        edges.push({ from: idByCanonical.get(ref)!, to: id });
        referenced.add(ref);
      }
    }
  }

  // Terminal edges: any node nothing else depends on flows to `__end__`.
  for (const node of modelNodes) {
    if (!referenced.has(node.name.toLowerCase())) {
      edges.push({ from: modelNodeId(node.name), to: '__end__' });
    }
  }

  return edges;
}

/**
 * Build a v3 manifest entry for a `kind: 'models'` pipeline: one node per model
 * (each with an exact-selection `model run <name>` command) and edges lifted
 * from each model's in-pipeline `ref`s. Throws on a node-id collision (two
 * models whose names differ only by case).
 */
function buildModelPipelineManifest(input: ModelPipelineTemplateInput): ModelPipelineManifest {
  const seenIds = new Map<string, string>();
  const nodes: ModelDagNode[] = input.modelNodes.map((modelNode) => {
    const id = modelNodeId(modelNode.name);
    const existing = seenIds.get(id);
    if (existing) {
      throw new CommandError(
        `Model pipeline "${input.pipelineName}" has two models ("${existing}" and "${modelNode.name}") whose node ids collide (${id}). Model names must be unique (case-insensitive).`,
        2
      );
    }
    seenIds.set(id, modelNode.name);
    const node: ModelDagNode = {
      id,
      kind: 'dogsled.model.run',
      model: modelNode.name,
      command: ['model', 'run', modelNode.name, '--integration', input.connection, '--json'],
      emits: ['model_runs'],
    };
    if (modelNode.tags && modelNode.tags.length > 0) node.tags = modelNode.tags;
    return node;
  });

  const manifest: ModelPipelineManifest = {
    name: input.pipelineName,
    kind: 'models',
    graph_id: input.graphId,
    connection: input.connection,
    ...(input.warehouse !== undefined ? { warehouse: input.warehouse } : {}),
    models: input.models,
    schedule: {
      expression: input.schedule,
      cron: input.cron ?? MANUAL_SCHEDULE_SENTINEL,
    },
    trigger: input.trigger,
    state: {
      model_runs: 'append',
      errors: 'append',
    },
    nodes,
    edges: buildModelDagEdges(input.modelNodes),
  };

  if (input.description !== undefined) {
    manifest.description = input.description;
  }
  if (input.synthetic) {
    manifest.synthetic = true;
  }
  return manifest;
}

/**
 * Map an entity-graph runtime phase to the leading `entity-graph` subcommand
 * tokens (everything before the per-pipeline entity-name argument list). Each
 * phase resolves to a distinct, standalone-runnable CLI surface so the host application
 * can execute every manifest phase node as its own `run_tasks` task:
 *   - `resolve`               → `entity-graph resolve run`
 *   - `cluster`               → `entity-graph resolve cluster`
 *   - `profile`               → `entity-graph resolve profile`
 *   - `extract_mentions`      → `entity-graph mentions extract`
 *   - `extract_relationships` → `entity-graph relationships extract`
 *
 * Backward-compat seam: the `resolve` token was historically
 * `['entity-graph','resolve','resolve']`, which is NOT an executable subcommand
 * (the `resolve` group exposes `run` / `cluster` / `profile` / …, never a
 * nested `resolve`). It now emits `resolve run`. These command tokens matter
 * only to adapters that exec `node.command` verbatim — the OSS pipeline
 * runner, the per-phase task runner, and the conformance reference adapter. The
 * Host-application's current entity-graph executor dispatches by each node's `phase`
 * field, not by the command tokens, so manifests already pinned under an older
 * `bundle_version` (which still carry the non-executable `resolve resolve`
 * token) keep running unchanged there. Under the host application contract, the host
 * sibling tolerates both tokens on any verbatim-exec path.
 *
 * `prepare_chunks` is deliberately absent here: it is a lakehouse-execution
 * adapter step (NOT an `entity-graph` CLI call), front-injected by the host application's
 * config synthesizer when `chunk_sources` are present. Dogsled never emits it as a
 * command node; the Host-application construction executor owns it as a pre-step. A Dogsled
 * CLI equivalent, if ever wanted, is a separate ticket.
 */
const ENTITY_GRAPH_PHASE_COMMAND_PREFIX: Record<EntityGraphPhase, string[]> = {
  resolve: ['entity-graph', 'resolve', 'run'],
  cluster: ['entity-graph', 'resolve', 'cluster'],
  profile: ['entity-graph', 'resolve', 'profile'],
  extract_mentions: ['entity-graph', 'mentions', 'extract'],
  extract_relationships: ['entity-graph', 'relationships', 'extract'],
};

/**
 * The construction (document-extraction) phases. Each consumes the per-entity
 * `__entity_profile` table, which the Host-application executor materializes as a
 * side-effect of construction today (run-entity-graph.ts's
 * `ensureConstructionOutputTables`). See `withInjectedProfilePhase`.
 */
const ENTITY_GRAPH_CONSTRUCTION_PHASES: readonly EntityGraphPhase[] = [
  'extract_mentions',
  'extract_relationships',
];

/**
 * Splice an auto-injected `profile` phase into a phase list when a
 * construction/extract phase is present and `profile` wasn't authored
 * explicitly. The `profile` node is inserted immediately before the first
 * construction phase — `profile` depends on resolution output (golden records)
 * and is in turn consumed by construction.
 *
 * This mirrors the Host-application executor, which builds `__entity_profile` as part of
 * construction at runtime today and therefore carries NO manifest node for it;
 * a naive per-phase DAG split would silently drop the profile step. Emitting it
 * as its own standalone-runnable node (`entity-graph resolve profile`) keeps the
 * per-phase split faithful.
 *
 * Behavior:
 *   - no construction phase            → returns the input unchanged.
 *   - construction present, no profile → injects `profile` immediately before
 *                                        the first construction phase.
 *   - profile authored before          → honored verbatim (no re-splice).
 *     construction
 *   - profile authored AFTER           → throws CommandError(2): construction
 *     construction                       would run before the `__entity_profile`
 *                                        dependency that `profile` produces.
 */
function withInjectedProfilePhase(phases: EntityGraphPhase[]): EntityGraphPhase[] {
  const firstConstructionIdx = phases.findIndex((phase) =>
    ENTITY_GRAPH_CONSTRUCTION_PHASES.includes(phase)
  );
  // No construction phase → nothing to gate; `profile` (if authored) stands alone.
  if (firstConstructionIdx === -1) return phases;

  const profileIdx = phases.indexOf('profile');
  if (profileIdx === -1) {
    return [
      ...phases.slice(0, firstConstructionIdx),
      'profile',
      ...phases.slice(firstConstructionIdx),
    ];
  }
  if (profileIdx > firstConstructionIdx) {
    throw new CommandError(
      'Entity-graph phase "profile" must appear before the construction phases ' +
        '("extract_mentions" / "extract_relationships"): it builds the ' +
        '__entity_profile table they consume.',
      2
    );
  }
  // Authored `profile` already precedes construction — honor it verbatim.
  return phases;
}

/**
 * Build a v3 manifest entry for a `kind: 'entity-graph'` pipeline: one node per
 * phase (each carrying its phase-specific CLI command via
 * `ENTITY_GRAPH_PHASE_COMMAND_PREFIX`) wired into a sequential chain
 * `__start__ → phase₀ → … → __end__`. Wildcard `entities: '*'` becomes a CLI
 * invocation without an entity-name argument list. A standalone `profile` node
 * is auto-injected ahead of construction (`withInjectedProfilePhase`) so the
 * per-phase DAG stays faithful. The injection affects `nodes`/`edges` only; the
 * manifest's `phases` field stays the authored list (see below).
 */
function buildEntityGraphPipelineManifest(
  input: EntityGraphPipelineTemplateInput
): EntityGraphPipelineManifest {
  const entityArgs = input.entities === '*' ? [] : [...input.entities];
  // Auto-inject a standalone `profile` node ahead of construction so the
  // per-phase DAG faithfully represents the profile step the executor folds
  // into construction at runtime today. This drives the v3 `nodes`/`edges`
  // ONLY — never the manifest's `phases` field (see below). `prepare_chunks` is
  // intentionally NOT injected: it is the Host-application construction executor's
  // responsibility (a lakehouse adapter pre-step), not a Dogsled CLI command. See
  // `withInjectedProfilePhase` and `ENTITY_GRAPH_PHASE_COMMAND_PREFIX`.
  const nodePhases = withInjectedProfilePhase(input.phases);
  const seenIds = new Map<string, EntityGraphPhase>();
  const nodes: EntityGraphNode[] = nodePhases.map((phase) => {
    const id = `phase_${phase}`;
    if (seenIds.has(id)) {
      throw new CommandError(
        `Entity-graph pipeline "${input.pipelineName}" lists phase "${phase}" more than once; each phase must appear at most once.`,
        2
      );
    }
    seenIds.set(id, phase);
    const incrementalArgs =
      phase === 'resolve' && input.defaultRunMode === 'incremental' ? ['--incremental'] : [];
    return {
      id,
      kind: 'dogsled.entity_graph.run',
      phase,
      command: [
        ...ENTITY_GRAPH_PHASE_COMMAND_PREFIX[phase],
        ...entityArgs,
        ...incrementalArgs,
        '--json',
      ],
      emits: ['entity_graph_runs'] as const,
    };
  });

  const edges: PipelineManifestEdge[] = [];
  if (nodes.length > 0) {
    edges.push({ from: '__start__', to: nodes[0]!.id });
    for (let i = 0; i < nodes.length - 1; i++) {
      edges.push({ from: nodes[i]!.id, to: nodes[i + 1]!.id });
    }
    edges.push({ from: nodes[nodes.length - 1]!.id, to: '__end__' });
  }

  const manifest: EntityGraphPipelineManifest = {
    name: input.pipelineName,
    kind: 'entity-graph',
    graph_id: input.graphId,
    connection: input.connection,
    entities: input.entities,
    // Authored phases verbatim — the auto-injected `profile` step lives ONLY in
    // the v3 `nodes`/`edges` DAG above, not here. The Host-application's current
    // entity-graph executor consumes this `phases` array verbatim and dispatches
    // by phase name; injecting `profile` here would mis-dispatch on executors
    // that predate the related compatibility change. The per-phase task runner
    // consumes `nodes[].command`, where `profile` correctly appears.
    phases: input.phases,
    schedule: {
      expression: input.schedule,
      cron: input.cron ?? MANUAL_SCHEDULE_SENTINEL,
    },
    trigger: input.trigger,
    state: {
      entity_graph_runs: 'append',
      errors: 'append',
    },
    nodes,
    edges,
  };

  if (input.description !== undefined) {
    manifest.description = input.description;
  }
  return manifest;
}

function buildReverseEtlPipelineManifest(
  input: ReverseEtlPipelineTemplateInput
): ReverseEtlPipelineManifest {
  const manifest: ReverseEtlPipelineManifest = {
    name: input.pipelineName,
    kind: 'reverse-etl',
    sync_name: input.syncName,
    graph_id: input.graphId,
    source_connection: input.sourceConnection,
    target_action: input.targetAction,
    schedule: {
      expression: input.schedule,
      cron: input.cron ?? MANUAL_SCHEDULE_SENTINEL,
    },
    trigger: input.trigger,
    state: {
      sync_runs: 'append',
      sync_receipts: 'append',
      errors: 'append',
    },
    command: ['sync', 'run', input.syncName, '--json'],
  };

  if (input.description !== undefined) {
    manifest.description = input.description;
  }
  if (input.destinationConnection !== undefined) {
    manifest.destination_connection = input.destinationConnection;
  }
  return manifest;
}

/**
 * Build the complete pipeline manifest object. Callers that need the JSON
 * string should use `serializePipelineManifest` (or the convenience
 * `buildPipelineManifest`).
 */
export function buildPipelineManifestObject(
  extractPipelines: PipelineTemplateInput[],
  modelPipelines: ModelPipelineTemplateInput[],
  bobsledVersion: string,
  entityGraphPipelines: EntityGraphPipelineTemplateInput[] = [],
  reverseEtlPipelines: ReverseEtlPipelineTemplateInput[] = []
): BobsledPipelineManifest {
  return {
    kind: 'dogsled.pipeline.dag',
    version: PIPELINE_MANIFEST_VERSION,
    dogsled_cli_version: bobsledVersion,
    command_contract: {
      default_command: 'dogsled',
      command_env: 'BOBSLED_CORE_PIPELINE_COMMAND',
      cwd_env: 'BOBSLED_CORE_PIPELINE_CWD',
      timeout_seconds_env: 'BOBSLED_CORE_PIPELINE_TIMEOUT_SECONDS',
      default_timeout_seconds: 1800,
      output: 'jsonl',
    },
    pipelines: [
      ...extractPipelines.map(buildExtractPipelineManifest),
      ...modelPipelines.map(buildModelPipelineManifest),
      ...entityGraphPipelines.map(buildEntityGraphPipelineManifest),
      ...reverseEtlPipelines.map(buildReverseEtlPipelineManifest),
    ],
  };
}

export function serializePipelineManifest(manifest: BobsledPipelineManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Legacy helper preserved for callers that still build the manifest from
 * extract pipelines alone (the `--from-resources` path). New callers should
 * prefer `buildPipelineManifestObject` + `serializePipelineManifest`.
 */
export function buildPipelineManifest(
  pipelines: PipelineTemplateInput[],
  bobsledVersion: string
): string {
  return serializePipelineManifest(buildPipelineManifestObject(pipelines, [], bobsledVersion));
}
