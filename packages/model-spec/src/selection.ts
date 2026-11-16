/**
 * Shared model-selection grammar (dbt-style) for `@bobsled-inc/model-spec`.
 *
 * Published at the `@bobsled-inc/model-spec/selection` subpath so BOTH the
 * Bobsled Core CLI (Model Spec `model run`/`compile`/…) and downstream host applications resolve
 * a selection to the SAME exact node set. This is one of the three cross-repo
 * contract seams for Pipelines v2 — keep its public API stable.
 *
 * The library is pure and graph-only: it knows nothing about disk, SQL, or
 * warehouses. Callers hand it a topologically-ordered list of selectable nodes
 * (each with its direct upstream **model** refs and optional tags) plus the raw
 * selector tokens, and get back the resolved, de-duplicated node names in
 * topological order.
 *
 * ## Grammar (dbt selection-UX parity — selection only, not dbt itself)
 *
 *   token := [`+`] core [`+`]
 *   core  := `<name>` | `tag:<value>`
 *
 *   - bare `X`      → exactly the node `X` (the v3 default; this is the
 *                    intentional dbt-parity breaking change vs the old
 *                    upstream-closure behavior of `subgraph()`).
 *   - `+X`         → `X` and ALL its ancestors (transitive upstream/parents).
 *   - `X+`         → `X` and ALL its descendants (transitive downstream/children).
 *   - `+X+`        → both ancestors and descendants of `X`.
 *   - `tag:foo`    → every node carrying tag `foo` (no graph expansion).
 *   - `tag:foo+`   → those nodes and all their descendants (operators compose
 *                    with `tag:` exactly as with names).
 *   - multiple tokens (one per array element) → UNION, de-duplicated by node.
 *   - no tokens (empty array) → ALL nodes.
 *
 * ## Matching rules
 *
 *   - Node NAMES match case-INSENSITIVELY (lowercased on both sides), mirroring
 *     the Model Spec DAG which canonicalizes model names/refs to lowercase.
 *   - TAGS match case-SENSITIVELY (verbatim), matching dbt tag semantics.
 *   - A bare token is ALWAYS a node name and NEVER falls back to a tag; a tag
 *     must use the `tag:` prefix. So a model named `foo` and a tag `foo` never
 *     collide.
 *   - An unknown NAME selector is a hard error (with the available-name list).
 *     An unknown TAG selector contributes nothing (no error) — only matters if
 *     it is the sole selector and the final set ends up empty.
 *
 * Intersection (dbt's comma syntax) and exclusion (dbt's `--exclude`) are NOT
 * supported in v1; a comma in a token is rejected with a clear error so the
 * grammar stays reservable for a future, non-breaking addition.
 */

import { CommandError } from './errors.js';

/** A node the selector can reason about. `refs` are direct upstream MODEL deps. */
export interface SelectableNode {
  /** Node name as authored. Matched case-insensitively. */
  name: string;
  /**
   * Direct upstream model dependencies (bare model names, not source refs).
   * Matched case-insensitively. Refs that don't correspond to a node in the
   * supplied set are ignored for graph traversal.
   */
  refs: string[];
  /** Optional tags carried verbatim from the spec. Matched case-sensitively. */
  tags?: string[];
}

/** The parsed form of a single selector token. */
export interface ParsedSelector {
  /** What the token's core resolves against. */
  core: { kind: 'name'; value: string } | { kind: 'tag'; value: string };
  /** `+` prefix — include transitive ancestors of the core set. */
  ancestors: boolean;
  /** `+` suffix — include transitive descendants of the core set. */
  descendants: boolean;
}

export interface ResolveSelectionOptions {
  /**
   * Override the "unknown name" error message prefix. Defaults to
   * `No models found matching` to preserve the historical CLI error substring.
   */
  unknownNameMessagePrefix?: string;
}

const TAG_PREFIX = 'tag:';
const UNKNOWN_NAME_PREFIX = 'No models found matching';

/**
 * Parse a single selector token into its structured form.
 *
 * Throws `CommandError(2)` for malformed tokens (empty core, a lone `+`/`tag:`,
 * or an unsupported intersection comma).
 */
export function parseSelector(token: string): ParsedSelector {
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    throw new CommandError(`Invalid selector: empty token.`, 2);
  }
  if (trimmed.includes(',')) {
    throw new CommandError(
      `Invalid selector "${token}": intersection selection (comma) is not supported. ` +
        `Pass each selector as a separate argument to union them.`,
      2
    );
  }

  let core = trimmed;
  const ancestors = core.startsWith('+');
  if (ancestors) core = core.slice(1);
  const descendants = core.endsWith('+');
  if (descendants) core = core.slice(0, -1);

  if (core.length === 0 || core.startsWith('+') || core.endsWith('+')) {
    // A lone `+`, `++`, or `+X+` with extra operators — reject rather than
    // silently treating `++X` as "two ancestors".
    throw new CommandError(
      `Invalid selector "${token}": expected an optional single leading and/or trailing "+" around a model name or tag: selector.`,
      2
    );
  }

  if (core.startsWith(TAG_PREFIX)) {
    const value = core.slice(TAG_PREFIX.length);
    if (value.length === 0) {
      throw new CommandError(`Invalid selector "${token}": empty tag value.`, 2);
    }
    return { core: { kind: 'tag', value }, ancestors, descendants };
  }

  return { core: { kind: 'name', value: core }, ancestors, descendants };
}

/**
 * Resolve dbt-style selector tokens against a topologically-ordered node list.
 *
 * Returns the selected node names (in the ORIGINAL case the nodes were supplied
 * in), filtered from `nodes` so the result preserves the caller's topological
 * order and is de-duplicated. An empty `selectors` array selects every node.
 */
export function resolveSelection(
  nodes: readonly SelectableNode[],
  selectors: readonly string[],
  options: ResolveSelectionOptions = {}
): string[] {
  // Drop genuinely-empty tokens (a stray '' arg); a token that is only
  // whitespace-then-operators is caught by parseSelector instead.
  const tokens = selectors.map((s) => s.trim()).filter((s) => s.length > 0);

  // Empty selection → all nodes, in input (topological) order.
  if (tokens.length === 0) {
    return nodes.map((n) => n.name);
  }

  const lc = (s: string): string => s.toLowerCase();

  // Canonical (lowercased) name → original-cased name, plus the node lookup.
  const canonicalToOriginal = new Map<string, string>();
  const byCanonical = new Map<string, SelectableNode>();
  for (const node of nodes) {
    const key = lc(node.name);
    canonicalToOriginal.set(key, node.name);
    byCanonical.set(key, node);
  }

  // parents: node → direct in-set upstream refs (canonical). children: reverse.
  const parents = new Map<string, Set<string>>();
  const children = new Map<string, Set<string>>();
  for (const node of nodes) {
    parents.set(lc(node.name), new Set());
    children.set(lc(node.name), new Set());
  }
  for (const node of nodes) {
    const self = lc(node.name);
    for (const ref of node.refs) {
      const parent = lc(ref);
      if (!byCanonical.has(parent) || parent === self) continue;
      parents.get(self)!.add(parent);
      children.get(parent)!.add(self);
    }
  }

  const collectClosure = (
    seeds: Iterable<string>,
    edges: Map<string, Set<string>>
  ): Set<string> => {
    const out = new Set<string>();
    const stack = [...seeds];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const next of edges.get(current) ?? []) {
        if (!out.has(next)) {
          out.add(next);
          stack.push(next);
        }
      }
    }
    return out;
  };

  const selected = new Set<string>();

  for (const token of tokens) {
    const parsed = parseSelector(token);
    const coreSet = new Set<string>();

    if (parsed.core.kind === 'tag') {
      // Tags are case-sensitive (dbt parity). Unknown tag → empty contribution.
      for (const node of nodes) {
        if (node.tags?.includes(parsed.core.value)) coreSet.add(lc(node.name));
      }
    } else {
      const key = lc(parsed.core.value);
      if (!byCanonical.has(key)) {
        const available = nodes
          .map((n) => n.name)
          .sort()
          .join(', ');
        const prefix = options.unknownNameMessagePrefix ?? UNKNOWN_NAME_PREFIX;
        throw new CommandError(
          `${prefix}: ${parsed.core.value}. Available models: ${available || '(none)'}`,
          2
        );
      }
      coreSet.add(key);
    }

    for (const member of coreSet) selected.add(member);
    if (parsed.ancestors) {
      for (const ancestor of collectClosure(coreSet, parents)) selected.add(ancestor);
    }
    if (parsed.descendants) {
      for (const descendant of collectClosure(coreSet, children)) selected.add(descendant);
    }
  }

  // Emit in topological (input) order, original case, de-duplicated.
  const result: string[] = [];
  for (const node of nodes) {
    if (selected.has(lc(node.name))) result.push(node.name);
  }
  return result;
}
