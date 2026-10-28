/**
 * Basic text-based lineage rendering from DAG nodes.
 *
 * Produces a simple dependency listing showing sources and model
 * dependencies for each model in topological order.
 * Includes effective trust tier when available.
 */

import type { DagNode } from './dag.js';
import type { TrustTier } from './schemas.js';

/**
 * Render a text-based lineage view of the DAG.
 *
 * Output format (one block per model):
 *
 *   stg_orders [bronze]
 *     <- ecom.raw_orders (source)
 *
 *   fct_orders [silver (effective: bronze)]
 *     <- stg_orders (model)
 *     <- stg_customers (model)
 */
export function renderLineage(nodes: DagNode[], effectiveTiers?: Map<string, TrustTier>): string {
  const lines: string[] = [];

  for (const node of nodes) {
    const tierInfo = formatTierInfo(node, effectiveTiers);
    lines.push(`${node.name}${tierInfo}`);

    for (const sourceRef of node.sourceRefs) {
      lines.push(`  \u2190 ${sourceRef} (source)`);
    }

    for (const ref of node.refs) {
      lines.push(`  \u2190 ${ref} (model)`);
    }

    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function formatTierInfo(node: DagNode, effectiveTiers?: Map<string, TrustTier>): string {
  const declared = node.parsedSpec.model_kind === 'agentic' ? 'bronze' : node.parsedSpec.trust_tier;
  if (!declared && !effectiveTiers) return '';

  const declaredTier = declared ?? 'bronze';
  const effectiveTier = effectiveTiers?.get(node.name);

  if (effectiveTier && effectiveTier !== declaredTier) {
    return ` [${declaredTier} (effective: ${effectiveTier})]`;
  }
  return ` [${declaredTier}]`;
}
