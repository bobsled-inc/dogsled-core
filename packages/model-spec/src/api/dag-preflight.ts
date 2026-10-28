/**
 * DAG-aware scheduling for warehouse preflight checks.
 *
 * A warehouse dry run validates SQL against the live catalog, so it rejects a
 * model that reads a relation which an upstream model in the same run has not
 * created yet. This module decides, per model, whether its preflight can run
 * before anything executes or must wait until its upstream models have run:
 *
 *   - a model whose relation inputs already exist is checked up front;
 *   - a model that reads a relation this run builds, and that relation does not
 *     exist yet (or is itself deferred), is checked just before it executes;
 *   - an upstream model this run does not build is an external input and must
 *     already exist.
 *
 * The module is dialect-neutral: callers supply relation existence and the
 * per-model check. Deferral changes only WHEN a model is checked, never
 * WHETHER it is checked.
 */

import type { DagNode, ModelGuardFailure, SqlStatement } from '../compiler/index.js';

import type { IntegrationCompileContext } from './integration-context.js';

export interface ModelRelationInputs {
  /** Materialized upstream models that this run builds before the model. */
  inRunModels: string[];
  /** Upstream models this run does not build. They must already exist. */
  externalModels: string[];
  /** Source refs read directly or through inlined ephemeral models. */
  sourceRefs: string[];
}

export interface CollectRelationInputsOptions {
  /**
   * Maps a source ref to the in-run model whose relation it reads, when a
   * source points at a table that this run builds.
   */
  sourceToInRunModel?: (sourceRef: string) => string | undefined;
  /**
   * Called when `reader` (the model, or an ephemeral model it inlines) reads a
   * source whose table is built earlier in this run. That source is checked by
   * the consuming model's dry run instead of the up-front source checks.
   */
  onBuiltSource?: (reader: string, sourceRef: string) => void;
  /**
   * Called when `model` reads a source whose table is built by `producer`, but
   * `producer` runs after `model` (the DAG has no edge between them). The
   * source stays a plain source and is checked up front.
   */
  onLateSource?: (model: string, sourceRef: string, producer: string) => void;
}

/** Models in execution order, taken from the statement plan. */
export function plannedModelOrder(statements: readonly SqlStatement[]): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const statement of statements) {
    const name = statement.modelName.toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    order.push(name);
  }
  return order;
}

/**
 * Collect each planned model's relation inputs. Ephemeral upstreams are inlined
 * as CTEs, so their own inputs count as inputs of the model that inlines them.
 */
export function collectModelRelationInputs(
  ictx: Pick<IntegrationCompileContext, 'orderedNodes'>,
  statements: readonly SqlStatement[],
  options: CollectRelationInputsOptions = {}
): Map<string, ModelRelationInputs> {
  const order = plannedModelOrder(statements);
  const inRun = new Set(order);
  const position = new Map(order.map((model, index) => [model, index]));
  const byName = new Map<string, DagNode>();
  for (const node of ictx.orderedNodes) byName.set(node.name.toLowerCase(), node);

  const inputs = new Map<string, ModelRelationInputs>();
  for (const model of order) {
    const node = byName.get(model);
    if (!node) continue;
    const inRunModels = new Set<string>();
    const externalModels = new Set<string>();
    const sourceRefs = new Set<string>();
    const visited = new Set<string>([model]);
    const stack: DagNode[] = [node];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const sourceRef of current.sourceRefs) {
        const producer = options.sourceToInRunModel?.(sourceRef)?.toLowerCase();
        // A source over an in-run table only orders after its producer when
        // the producer really runs first; the DAG has no edge for it.
        if (producer && (position.get(producer) ?? Infinity) < (position.get(model) ?? -1)) {
          inRunModels.add(producer);
          options.onBuiltSource?.(current.name.toLowerCase(), sourceRef);
        } else {
          sourceRefs.add(sourceRef);
          if (producer && producer !== model) options.onLateSource?.(model, sourceRef, producer);
        }
      }
      for (const rawRef of current.refs) {
        const ref = rawRef.toLowerCase();
        if (visited.has(ref)) continue;
        visited.add(ref);
        const upstream = byName.get(ref);
        if (upstream?.materialization === 'ephemeral') {
          stack.push(upstream);
        } else if (inRun.has(ref)) {
          inRunModels.add(ref);
        } else {
          externalModels.add(ref);
        }
      }
    }
    inputs.set(model, {
      inRunModels: [...inRunModels].sort(),
      externalModels: [...externalModels].sort(),
      sourceRefs: [...sourceRefs].sort(),
    });
  }
  return inputs;
}

/**
 * Decide which models must be checked just before they execute. A model is
 * deferred when an in-run upstream relation does not exist yet, or when that
 * upstream is itself deferred (a view over a missing table cannot be planned
 * either). Returns each deferred model with the upstream models that caused it.
 */
export function planDeferredModels(
  order: readonly string[],
  inputs: ReadonlyMap<string, ModelRelationInputs>,
  relationExists: (model: string) => boolean
): Map<string, string[]> {
  const deferred = new Map<string, string[]>();
  for (const model of order) {
    const upstreams = inputs.get(model)?.inRunModels ?? [];
    const waitingOn = upstreams.filter(
      (upstream) => deferred.has(upstream) || !relationExists(upstream)
    );
    if (waitingOn.length > 0) deferred.set(model, waitingOn);
  }
  return deferred;
}

/**
 * Build an executor `beforeModel` guard that runs `check` for each deferred
 * model immediately before its first statement. Returns `undefined` when no
 * model is deferred, so the executor keeps its original behavior.
 */
export function createDeferredModelGuard(
  deferred: ReadonlyMap<string, string[]>,
  check: (model: string) => Promise<ModelGuardFailure | undefined>
): ((modelName: string) => Promise<ModelGuardFailure | undefined>) | undefined {
  if (deferred.size === 0) return undefined;
  return async (modelName) => {
    const model = modelName.toLowerCase();
    if (!deferred.has(model)) return undefined;
    return check(model);
  };
}
