---
module: explorer
date: 2026-04-20
problem_type: runtime_error
component: app/api/mdm/decide/route.ts, lib/mdm-workspace.ts, workspace/mdm-aurelia-demo/runner.duckdb.js
symptoms:
  - 'Review decisions in Explorer could fail intermittently after opening queue or cluster data'
  - 'The MDM UI returned "Failed to record review decision." even though the payload was valid'
  - 'The write path raced with a cached DuckDB runner connection that still held the demo database file lock'
root_cause: Explorer reused a cached read-only DuckDB runner for SQL inspection, but the review CLI path needs a write lock on the same database file
severity: medium
tags: [explorer, mdm, duckdb, file-lock, nextjs, cli]
---

# MDM Review Decide DuckDB Lock in Explorer

## Symptom

Explorer’s MDM review flow mixed two different access patterns against the same demo database:

- `runMdmSql()` dynamically imported the scenario runner and kept its DuckDB connection open for queue and cluster reads.
- `/api/mdm/decide` then spawned `dogsled mdm review decide`, which needs write access to persist the decision and advance downstream tables.

In practice that meant a user could inspect a pair, click a decision, and get a generic API failure even though the pair ID and decision were valid. The problem was intermittent because it depended on whether the long-lived Next.js process had already touched the runner module for that scenario.

## Investigation

1. The request validation path was fine: malformed payloads correctly returned 400s, but valid payloads still sometimes returned 500.
2. The failures clustered after queue or cluster reads, which pointed to shared database access instead of bad decision inputs.
3. The scenario runner caches a DuckDB connection, so importing it for read queries leaves the process attached to the database file.
4. The CLI write path was then competing with that same cached connection inside the Explorer server process.

## Root Cause

The demo runner is intentionally cached for repeated reads, but that same cache became a liability on write operations. DuckDB enforces file locking, so a previously imported runner module could keep the database open long enough for `dogsled mdm review decide` to fail acquiring its write lock.

The issue was not specific to one scenario; it applied to any Explorer MDM workspace that uses the shared runner helper.

## Solution

Teach the Explorer write path to explicitly release the cached runner connection before any CLI command that needs write access.

Key changes:

- Add `closeMdmRunnerConnection()` in `apps/explorer/src/lib/mdm-workspace.ts` (now [`entity-graph-workspace.ts`](../../../apps/explorer/src/lib/entity-graph-workspace.ts)) to call an optional `close()` export on the dynamically imported runner.
- Call that helper at the start of `apps/explorer/src/app/api/mdm/decide/route.ts` (now [`entity-graph/decide/route.ts`](../../../apps/explorer/src/app/api/entity-graph/decide/route.ts)) before spawning `dogsled mdm review decide`.
- Reuse the same release step before follow-up cluster/profile/survivorship refresh commands so the full decision pipeline can reacquire the database cleanly.

This keeps read-heavy Explorer pages fast while making the write path deterministic.

## Prevention

1. Any Explorer route that mixes `runMdmSql()` reads with spawned CLI writes should release the cached runner first.
2. Scenario-aware helpers need to treat the runner module as shared mutable state, not a stateless utility.
3. When adding new live-write MDM actions, test them after visiting queue or cluster pages so read-lock regressions surface quickly.

## Related Issues

- [MDM Codegen `src.*` Wildcard Column Collision](../2026-04-16-mdm-codegen-src-wildcard-column-collision.md)
