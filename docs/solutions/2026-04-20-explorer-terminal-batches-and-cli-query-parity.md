# Explorer Terminal Batches and CLI Query Parity

Date: 2026-04-20

## Context

Explorer had drifted away from the real Dogsled CLI contract in two user-facing places:

- Data Preview called `dogsled load query --sql ... --json`, even though `load query` accepts positional SQL and prints tabular stdout.
- The main terminal CTA only ran `selectedIntegrations[0]`, so a multi-integration builder config silently dropped every later integration.

The MDM demo also assumed a pre-seeded workspace, which made `/api/mdm/run` fail from a clean checkout.

## Solution

- Keep Data Preview on the public CLI path instead of bypassing it.
  - `/api/query` now shells `dogsled load query --db-path <path> <sql>` and parses the tabular stdout back into structured rows for the UI.
  - Exported CLI snippets use that same positional SQL form, so the docs and the product teach the same command users can actually run.
- Represent multi-source terminal parity as a command batch instead of inventing a second execution model.
  - `buildPipelineRunArgs()` now returns either one `dogsled pipeline ...` command or a sequence of them.
  - `/api/command`, the terminal page, and run history all understand those sequences and stream them sequentially, stopping on the first failure.
- Make the MDM demo self-bootstrapping.
  - `/api/mdm/run` now runs `dogsled model seed load` before the resolve, cluster, profile, and survivorship steps.

## Why This Matters

Explorer now stays aligned with the shipped CLI semantics instead of teaching one command contract in the UI and another in the real product. Batching existing `dogsled pipeline` invocations also keeps the multi-integration flow debuggable and auditable without temp config files or a special-purpose runner path.
