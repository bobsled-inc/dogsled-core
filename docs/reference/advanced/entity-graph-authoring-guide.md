# Entity Graph Authoring Guide

Dogsled's OSS entity graph workflow is broad enough that operators and coding agents need one place that explains which command to use when. This guide covers the shipped CLI, the recommended authoring loop, and the current simplification roadmap. For the stable ID model used by clustering, crosswalks, clean views, profiles, and survivorship, see [Entity Graph Stable Entity IDs](entity-graph-stable-entity-ids.md).

## Status

### Shipped

| Area                   | Commands                                                                                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Resolution authoring   | `resolve init`, `resolve validate`, `resolve compile`, `resolve run`, `resolve run --incremental`, `resolve cluster`, `resolve profile`, `resolve report`, `resolve status`, `resolve estimate`, `resolve estimate --incremental`, `resolve inspect pair`, `resolve inspect cluster` |
| Review workflow        | `review export`, `review list`, `review show`, `review decide`, `review apply`                                                                                                                                                                                                       |
| Reference data         | `seed validate`, `seed load`, `seed diff`                                                                                                                                                                                                                                            |
| Survivorship           | `survivorship init`, `survivorship validate`, `survivorship compile`, `survivorship run`, `survivorship inspect`                                                                                                                                                                     |
| Threshold regression   | `truthset init`, `truthset validate`, `truthset score`, `truthset tune`, `truthset train`                                                                                                                                                                                            |
| Bounded agent routines | `agent triage`, `agent review-batch`, `agent survivorship-refresh`, `agent truthset-regress`, `agent init-profile`                                                                                                                                                                   |
| Contract surfaces      | `build`, `status`, `audit list`, `audit verify`                                                                                                                                                                                                                                      |
| Column-level lineage   | `lineage compile`, `lineage --entity <name> --attribute <attr>`                                                                                                                                                                                                                      |
| Provenance explain     | `explain --subject entity`                                                                                                                                                                                                                                                           |
| Mentions + Typed SDK   | `mentions review export`, `dogsled sdk generate`                                                                                                                                                                                                                                     |
| Privacy and governance | `pii scan`, `forget`, `policy`                                                                                                                                                                                                                                                       |
| Live access plane      | `get`, `match`, `serve`                                                                                                                                                                                                                                                              |

### Roadmap only

The old roadmap references to `quickstart`, `fixtures`, `suggest`, `scaffold`, and `diff` are no longer placeholders; those commands are registered. Before writing docs or prompts for a newer command, verify the registration in `packages/entity-graph/src/index.ts` and the corresponding command file.

See the Recommended Authoring Loop below for end-to-end examples.

If you are writing docs, prompts, or skills for agents, do not describe those commands as available until they exist in the registered CLI commands.

## Command Map

| Task                                     | Use now                                                                  | Notes                                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start a new resolution spec              | `resolve init <entity>`                                                  | Scaffolds a baseline YAML in the current spec directory (`entity-graph/` by default).                                                               |
| Validate spec structure                  | `resolve validate [entity...] --json`                                    | Use `--json` for agent consumption.                                                                                                                 |
| Inspect compiled SQL before execution    | `resolve compile [entity...] -o ./sql`                                   | Use this before changing warehouse state.                                                                                                           |
| Run stages 1-4                           | `resolve run [entity...] --runner ./runner.js --json`                    | Populates `__standardized`, `__candidate_pairs`, `__pair_scores`, and `__review_queue`.                                                             |
| Run a delta after a baseline             | `resolve run [entity...] --runner ./runner.js --incremental --json`      | Requires `query(sql)` to read `__resolve_state`; falls back to full on state/spec/watermark mismatch.                                               |
| Check runtime state                      | `resolve status`, `resolve estimate`                                     | `status` gives row counts; `estimate` shows threshold-band volumes.                                                                                 |
| Estimate the next delta                  | `resolve estimate --incremental --runner ./runner.js --json`             | Uses resolve-state watermarks to show delta row/pair volume before a run.                                                                           |
| Debug a specific pair or entity cluster  | `resolve inspect pair`, `resolve inspect cluster`, `review show`         | Use these before changing thresholds, review decisions, or stable ID expectations.                                                                  |
| Export review work                       | `review export ... --template`                                           | Add `--runner` plus `query(sql)` when you want materialized CSV, JSON, or YAML.                                                                     |
| Apply one decision programmatically      | `review decide --entity <name> --pair-id <id> --decision <value>`        | `<value>` is one of `merge`, `not_match`, `defer`, or `escalate`. Prefer for one-off agent actions.                                                 |
| Apply a reviewed file or bundle          | `review apply --input <path> --entity <name>`                            | Accepts CSV, JSON, YAML, or `entity_graph_decision_bundle.v1`. Pass `-` as the path to read from stdin.                                             |
| Apply a previously imported batch        | `review apply --batch-id <batch> --entity <name>`                        | Re-apply a batch already loaded into `__review_decisions` without re-uploading the file.                                                            |
| Agent-review the unreviewed gray zone    | `resolve review [entity...] --runner ./runner.js`                        | Model judge from `agent_policy.model` or external reviewer from `agent_policy.reviewer`; `--dry-run` returns the bundle without writing. See below. |
| Rebuild identity outputs after review    | `resolve cluster`, then `resolve profile`                                | `profile` materializes `__entity_profile` and `__entity_quality`.                                                                                   |
| Export document mention review rows      | `mentions review export --runner ./runner.js --json`                     | Run `mentions extract` first; then emits the model-review envelope plus mention columns.                                                            |
| Generate a typed SDK                     | `dogsled sdk generate --lang ts --out ./generated/dogsled-sdk`           | Run after profiles are fresh; generated SDK keys match entity spec names.                                                                           |
| Read one golden entity                   | `get --entity <name> --id <entity_id> --runner ./runner.js --json`       | Returns the golden profile plus quality and crosswalk context.                                                                                      |
| Lookup/stage/assign one source record    | `match --entity <name> --input ./record.json --mode <mode>`              | `lookup` is read-only; `stage`/`assign` mutate `__match_inbox`/identity tables and require valid IDs.                                               |
| Serve the access API locally             | `serve --port 8765 --runner ./runner.js --json`                          | Loopback/read-only by default. Add `--allow-writes` only for trusted local write flows.                                                             |
| Scan source fields for PII               | `pii scan --entity <name> --runner ./runner.js --json`                   | `--apply` writes reviewable Model Spec `pii: true` patches.                                                                                         |
| Erase a source record from graph outputs | `forget --entity <name> --source-ref <ref> --pk '<json>' --json`         | Writes a tombstone, purges derived surfaces, and prevents resurrection on future runs.                                                              |
| Build golden records                     | `survivorship run`, then `survivorship inspect`                          | Run after clustering.                                                                                                                               |
| Measure or train threshold quality       | `truthset score`, `truthset tune`, then `truthset train`                 | `train` emits Fellegi-Sunter `prior`/`m`/`u` estimates from labeled truthsets.                                                                      |
| Ask one agent task what to do next       | `agent triage --json`                                                    | Best entry point for unattended routines.                                                                                                           |
| Propose batch review decisions           | `agent review-batch --entity <name> --mode propose --runner ./runner.js` | Default mode. Writes a proposal bundle for later `review apply`.                                                                                    |
| Apply batch review decisions             | `agent review-batch --entity <name> --mode apply --runner ./runner.js`   | Only when the task explicitly allows writes.                                                                                                        |
| Refresh downstream golden record outputs | `agent survivorship-refresh`                                             | Uses the current cluster state.                                                                                                                     |
| Regress thresholds against labels        | `agent truthset-regress`                                                 | Wrapper around truthset scoring and recommendation flow.                                                                                            |
| Compile attribute lineage to warehouse   | `lineage compile --runner ./runner.js --json`                            | Writes schema-level provenance to `entity_graph.lineage`. Idempotent DELETE+INSERT per entity type.                                                 |
| Query lineage for one attribute          | `lineage --entity <name> --attribute <attr> --runner ./runner.js --json` | Returns upstream source columns. `is_complete=false` means source is opaque (raw SQL).                                                              |
| Explain entity with provenance           | `explain --subject entity --entity-id <id> --runner ./runner.js --json`  | Includes a `lineage_provenance` block per attribute when lineage rows exist.                                                                        |

## Recommended Authoring Loop

### 1. Start from the example project

Use [`packages/model-spec/examples/entity-graph-b2b-company-master/README.md`](../../../packages/model-spec/examples/entity-graph-b2b-company-master/README.md) as the concrete reference. It exercises resolution, review, survivorship, truthsets, and agent tasks against one entity.

### 2. Author and validate

```bash
dogsled entity-graph resolve init company
dogsled entity-graph resolve validate company --json
dogsled entity-graph resolve compile company -o ./sql
```

If you are iterating on seeds too, validate them before the first warehouse run:

```bash
dogsled model seed validate --json
dogsled model seed load --runner ./runner.js --json
```

### 3. Run and inspect

```bash
dogsled entity-graph resolve run company --runner ./runner.js --json
dogsled entity-graph resolve status company --runner ./runner.js --json
dogsled entity-graph resolve estimate company --runner ./runner.js --json
dogsled entity-graph resolve inspect pair --entity company --pair-id <pair_id> --runner ./runner.js --json
dogsled entity-graph resolve inspect cluster --entity company --entity-id <entity_id> --runner ./runner.js --json
```

Use `resolve inspect pair` when you need pair-level context and `review show` when you want the review-facing rendering of that same pair.

After the first full run has written `<entity>__resolve_state`, use incremental mode for ordinary refreshes:

```bash
dogsled entity-graph resolve estimate company --runner ./runner.js --incremental --json
dogsled entity-graph resolve run company --runner ./runner.js --incremental --json
```

Read the returned `mode` and `mode_reason` fields. A requested incremental run legitimately compiles as full when the baseline state is missing, the spec fingerprint changed, or an input cannot produce a safe delta watermark.

### 4. Review and cluster

```bash
dogsled entity-graph review export company --template --format csv --runner ./runner.js --output ./review/company_queue.csv
dogsled entity-graph review apply --input ./review/company_queue.csv --entity company --runner ./runner.js --json
dogsled entity-graph resolve cluster company --runner ./runner.js --json
dogsled entity-graph resolve profile company --runner ./runner.js --json
dogsled entity-graph mentions extract company --runner ./runner.js --fallback compromise --json
dogsled entity-graph mentions review export --runner ./runner.js --schema entity_graph --json
dogsled sdk generate --lang ts --out ./generated/dogsled-sdk --json
```

Use `review list` or `review decide` when an agent should make a few explicit decisions instead of producing a whole file.

### 4.5. Use the access plane for live reads and record intake

```bash
dogsled entity-graph get --entity company --id <entity_id> --runner ./runner.js --json
dogsled entity-graph match --entity company --input ./record.json --mode lookup --runner ./runner.js --json
dogsled entity-graph match --entity company --input ./record.json --mode stage --runner ./runner.js --json
dogsled entity-graph serve --port 8765 --runner ./runner.js --json
```

`match` records must include the selected input's `id_fields` as non-null scalar values. Use `source_ref` or `_source_ref` in the record when multiple inputs could match the same field shape. `serve` is loopback and read-only by default; `assign`/`stage` over HTTP require `--allow-writes`, and remote binds require both `--allow-remote` and `DOGSLED_ENTITY_GRAPH_ALLOW_REMOTE=1`.

### 5. Inspect stable IDs

After `resolve cluster`, the serving ID is `entity_id`. `cluster_id` remains as a compatibility alias for current outputs, and `component_id` is the current connected-component topology ID for debugging.

```bash
dogsled entity-graph resolve cluster company --runner ./runner.js --json
dogsled entity-graph resolve inspect cluster --entity company --entity-id <entity_id> --runner ./runner.js --json
```

The cluster JSON includes `entity_id_summary` counts for new, reused, merged, split, and reactivated IDs. Use the dedicated [stable entity ID reference](entity-graph-stable-entity-ids.md) when you need to explain merge aliases, reviewed splits, reactivation, or clean-view metadata columns such as `ENTITY_GRAPH_ENTITY_ID`.

### 6. Build serving surfaces

```bash
dogsled entity-graph build company --runner ./runner.js --json
dogsled entity-graph status --runner ./runner.js --json
dogsled entity-graph audit verify --runner ./runner.js --json
dogsled entity-graph survivorship run company --runner ./runner.js --json
dogsled entity-graph survivorship inspect company --runner ./runner.js --json
```

`build` refreshes the per-entity identity tables, colocated survivorship specs, and the shared `entity_graph.*` contract surfaces. Use `audit list --cluster-id <id>` when you need the mutation chain for a cluster.

The runtime overview report is intentionally the only packaged report in Drop 1:

```bash
dogsled entity-graph resolve report overview --entity company --runner ./runner.js --format markdown
```

Other report shapes can be queried directly from the contract surfaces:

```sql
-- Quality distribution
SELECT trust_tier, COUNT(*) AS clusters
FROM entity_graph.entity_quality_current
WHERE entity_type LIKE '%.company'
GROUP BY trust_tier;

-- Source coverage
SELECT source_system, COUNT(DISTINCT cluster_id) AS covered_clusters
FROM entity_graph.crosswalks
WHERE entity_type LIKE '%.company'
GROUP BY source_system;

-- Drift proxy: review backlog by band
SELECT threshold_band, COUNT(*) AS pending_pairs
FROM entity_graph.company__review_queue rq
LEFT JOIN entity_graph.company__review_decisions rd
  ON rq.pair_id = rd.pair_id
WHERE rd.pair_id IS NULL
GROUP BY threshold_band;
```

### 7. Regress thresholds with labels

```bash
dogsled entity-graph truthset score company --runner ./runner.js --json
dogsled entity-graph truthset tune company --runner ./runner.js --json
dogsled entity-graph truthset train company --runner ./runner.js --json
```

Truthset output is advisory. Treat tuned thresholds and trained Fellegi-Sunter weights as inputs to a reviewed spec change.

## Agent Workflow

Use the `agent` command group when the task is intentionally bounded and you want one invocation to return a next action or artifact bundle.

```bash
dogsled entity-graph agent triage company --runner ./runner.js --json
dogsled entity-graph agent review-batch --entity company --mode propose --runner ./runner.js --json
dogsled entity-graph agent survivorship-refresh company --runner ./runner.js --json
dogsled entity-graph agent truthset-regress company --runner ./runner.js --json
```

Rules for agents:

- Prefer `--json` on every entity graph command that feeds another agent or script.
- Default `agent review-batch` to `--mode propose`.
- Use repo-native profiles under `entity-graph/agent/*.yml` when a repo already carries policy, limits, or output paths.
- Keep low-level primitives as the source of truth. The `agent` commands are wrappers, not a replacement API.

## Agent Review (model judge)

`resolve review` is the separately callable review phase between `resolve run`
(threshold routing fills `__review_queue`) and `resolve cluster` (applied
merges fold into golden records). It fetches the unreviewed gray-zone pairs,
has an LLM judge adjudicate each one (`merge` / `not_match` / `defer`), and
writes the decisions through the same confidence gate as `review apply`:
confidence at/above `agent_policy.auto_apply_threshold` lands as `applied`,
below it as `proposed` (human confirmation), and `defer` as `deferred`.
`resolve run`'s default behavior never changes — review only happens when you
invoke it.

Configuration lives in the resolution spec plus a `dogsled.yml` model role:

```yaml
# entity-graph/<entity>_resolution.yml
agent_policy:
  enabled: true # required for resolve review to run
  model: reviewer # role name resolved against platform.models
  max_pairs_per_run: 25
  batch_size: 10
  max_cost_usd: 5
  auto_apply_threshold: 0.85
  context_fields: [name, website, phone, country]
  confirm_before_write: true # optional: CLI then requires --yes for real writes

entity_semantics: # folded into the judge's prompt
  definition: A company is a distinct legal business entity...
  positive_examples: ['Acme Corp ↔ Acme Corporation (same domain)']
  negative_examples: ['Acme US ↔ Acme Japan (regional subsidiaries)']

# dogsled.yml (same directory or any parent)
platform:
  models:
    reviewer:
      provider: anthropic
      model: claude-sonnet-4-5
      api_key: $ANTHROPIC_API_KEY # env indirection — never a literal
```

```bash
dogsled entity-graph resolve review company --runner ./runner.js --dry-run --json  # judge runs, nothing written
dogsled entity-graph resolve review company --runner ./runner.js                   # gated decisions written
dogsled entity-graph resolve cluster company --runner ./runner.js                  # applied merges fold in
```

Semantics worth knowing:

- **Fail-soft.** Judge problems (provider errors, schema violations, budget
  stops) never fail the run: affected pairs come back as `defer` with a
  warning, and pairs never reached stay in the queue for the next run.
- **Deterministic.** Temperature 0, structured output schema, stable batch
  ordering; pairs with any existing decision are skipped.
- **Panel-aware.** When `agent_policy.panel` is enabled, panel roles are
  resolved against `platform.models` and reviewed through the existing
  multi-model consensus machinery.
- **Programmatic.** `reviewResolveProject(...)` in
  `@bobsled-inc/entity-graph/api` is the same phase for hosts, with an
  injectable `llmClient` override that bypasses `agent_policy` entirely.

### External reviewer (bring your own agent)

Instead of the in-dogsled model judge, `agent_policy.reviewer` ships each batch
of pairs to an agent you host (`kind: http`) or run locally (`kind: command`):

```yaml
agent_policy:
  enabled: true
  reviewer:
    kind: http
    url: https://reviewer.example/review
    auth_token: ${{ env.DOGSLED_REVIEWER_TOKEN }} # env placeholder — never a literal
    timeout_s: 300
    poll_interval_s: 5
    # — or —
    # kind: command
    # command: 'node my-reviewer.mjs'
```

When `reviewer` is set it wins over `model`/`panel`; its decisions land with
`decision_source: 'agent'` (the model judge writes `'agent_auto'`) and flow
through the same confidence gate. A reviewer that times out, crashes, or
returns garbage never fails the run — undecided pairs stay queued and the run
finishes with warnings. The full wire contract (request/response JSON, both
transports, failure semantics) lives in
[`docs/reference/advanced/entity-graph-reviewer-contract.md`](entity-graph-reviewer-contract.md).

### Judge tier (`agent_policy.judge`)

`agent_policy.judge` pins which lane serves the review phase, per entity:

```yaml
agent_policy:
  enabled: true
  judge: agent # 'model' | 'agent'; omit for the default (model)
  reviewer: # required when judge: agent (unless a host injects one)
    kind: command
    command: 'node my-reviewer.mjs'
```

- **absent (default → model)** — today's precedence, unchanged: an external
  reviewer still wins when configured, otherwise the model judge / panel serves.
  Every existing spec keeps working.
- **`model`** — pin the in-dogsled model judge; an external `reviewer` or
  `reviewerOverride` is ignored and the ignore is warned about (a host-injected
  `llmClient` remains the explicit exception). Use it to guarantee an entity is
  never routed to a managed agent tier.
- **`agent`** — require an external/tool-using reviewer. With no `reviewer`
  configured (and no host override) the phase skips with
  `skipped_reason: 'no_judge_configured'` and a warning naming the missing piece
  — it never silently falls back to the model judge.

A host-injected `llmClient` still wins over any tier (the programmatic escape
hatch). Skips are fail-soft: the queue is left intact and the run stays green.

## Runner Requirements

| Capability                       | Needed for                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run(sql)`                       | `resolve run`, `resolve cluster`, `resolve profile`, `review apply`, `review decide`, `seed load`, `survivorship run`, `agent review-batch --mode apply`, `agent survivorship-refresh`                                                                                                                                                                                                      |
| `query(sql)`                     | `review export --runner`, `review list`, `review show`, `resolve status`, `resolve estimate`, `resolve estimate --incremental`, `resolve run --incremental`, `resolve inspect pair`, `resolve inspect cluster`, `get`, `match --mode lookup`, `serve` read endpoints, `survivorship inspect`, `truthset score`, `truthset tune`, `truthset train`, `agent triage`, `agent truthset-regress` |
| `run(sql)` and `query(sql)`      | `resolve review`, `match --mode stage`, `match --mode assign`, `forget`, `serve --allow-writes`, PII scan with warehouse samples                                                                                                                                                                                                                                                            |
| Both `run(sql)` and `query(sql)` | Best default for any shared `runner.js` used across the full entity graph loop                                                                                                                                                                                                                                                                                                              |

## Related Docs and Skills

- External reviewer contract: [`docs/reference/advanced/entity-graph-reviewer-contract.md`](entity-graph-reviewer-contract.md)
- Column lineage guide: [`docs/reference/advanced/entity-graph-lineage-guide.md`](entity-graph-lineage-guide.md)
- Entity graph overview: [`docs/guides/entity-graph.md`](../../guides/entity-graph.md)
- Mention extraction guide: [`docs/reference/advanced/mention-extraction.md`](mention-extraction.md)
- SDK codegen guide: [`docs/reference/advanced/sdk-codegen.md`](sdk-codegen.md)
- MCP `read_source` guide: [`docs/reference/advanced/mcp-read-source.md`](mcp-read-source.md)
- Package docs: [`packages/model-spec/README.md`](../../../packages/model-spec/README.md)
- Model profiler quick start: [`packages/model-spec/docs/profiler-quickstart.md`](../../../packages/model-spec/docs/profiler-quickstart.md)
- Model profiler user guide: [`packages/model-spec/docs/profiler-user-guide.md`](../../../packages/model-spec/docs/profiler-user-guide.md)
- Package agent manual: [`packages/model-spec/AGENTS.md`](../../../packages/model-spec/AGENTS.md)
- Stable ID reference: [`docs/reference/advanced/entity-graph-stable-entity-ids.md`](entity-graph-stable-entity-ids.md)
- host agent skills package: [`packages/skills/README.md`](../../../packages/skills/README.md)
- Example project: [`packages/model-spec/examples/entity-graph-b2b-company-master/README.md`](../../../packages/model-spec/examples/entity-graph-b2b-company-master/README.md)
- Profiler skill: [`.agents/skills/model-profiler/SKILL.md`](../../../.agents/skills/model-profiler/SKILL.md)
- Operational skill: [`.agents/skills/entity-graph-resolve/SKILL.md`](../../../.agents/skills/entity-graph-resolve/SKILL.md)
- Authoring skill: [`.agents/skills/entity-graph-authoring/SKILL.md`](../../../.agents/skills/entity-graph-authoring/SKILL.md)
