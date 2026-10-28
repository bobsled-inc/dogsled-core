# Recursive CTE Connected-Components Does Not Converge Without LEAST() Propagation

## Problem

The MDM entity clustering pipeline generates a recursive CTE to find connected components across matched pairs. The naive recursive step propagates `c.component_id` to the neighbor node, but this does not guarantee the globally minimum label reaches all nodes in the component.

For a chain A→B→C→D with only edges A-B, B-C, C-D, the recursion visits one edge per level. Without `LEAST()`, node C gets the label carried by B (which is A), but D gets the label carried by C at iteration 3 — which works in a simple chain. The real failure is **multi-source convergence**: if D has its own component from another path (D→E), D's final label depends on which path the recursion explored first, not on the globally minimum node in the component.

The original code:

```sql
SELECT e.node_b, c.component_id, c.depth + 1
FROM components c
JOIN all_edges e ON c.node_id = e.node_a
WHERE c.depth < 100
```

## Solution

Use `LEAST(c.component_id, e.node_b)` as the propagated label, and guard with `c.component_id < e.node_b` to only continue propagating when the current label is strictly smaller than the neighbor's own ID (i.e., there is an actual improvement to propagate):

```sql
SELECT e.node_b, LEAST(c.component_id, e.node_b), c.depth + 1
FROM components c
JOIN all_edges e ON c.node_id = e.node_a
WHERE c.depth < 100
  AND c.component_id < e.node_b
```

The `AND c.component_id < e.node_b` guard is critical: without it the recursion redundantly re-explores all already-converged edges. With it, propagation only continues when there is a smaller label to push forward, ensuring O(diameter) iterations instead of potentially infinite cycling.

`UNION` (not `UNION ALL`) deduplicates across recursion levels, so once a node is assigned the minimum label for its component no further propagation is needed for that assignment.

## Why This Matters

Star-topology graphs (one hub, many spokes) converge correctly even with the naive approach because all spokes get the hub's label in a single hop. But real-world entity graphs are rarely stars — they have chains, triangles, and small-world structures where entities are linked through intermediaries. Using the naive recursive step silently splits clusters that should be merged, producing incorrect deduplication results without any error or warning.

The fix is a two-token change (`LEAST(c.component_id, e.node_b)` and the guard predicate) but requires understanding why label-propagation connected-components needs minimum-label convergence, not just reachability.
