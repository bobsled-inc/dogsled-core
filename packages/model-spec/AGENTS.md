# @bobsled-inc/model-spec — Agent Operating Manual

<!-- last-reviewed: 2026-07-28 -->

`@bobsled-inc/model-spec` is the standalone Model Spec compiler package. It owns declarative source/model/seed parsing, read-only model profiling, DAG resolution, dialect-aware SQL generation, and the shared CLI helpers used by the dedicated Entity Graph package.

Entity Graph no longer lives in this package. Use `bobsled entity-graph` for the CLI surface from `packages/entity-graph/`. If you need entity-resolution, review, survivorship, truthset, or agent-task code, start in `packages/entity-graph/`.

---

## Package Boundaries

- The `/ossie`, `/interchange`, and `/ontology` entrypoints serve config-only discovery, validation and conversion. Keep its runtime import graph free of `connections` and database SDKs; the packed-install test checks this boundary with those packages removed.
- `packages/model-spec/` owns modeling, profiler, and seed functionality only.
- `packages/entity-graph/` owns the Entity Graph CLI plus identity-resolution-specific compiler code.
- `packages/model-spec/src/shared.ts` is the only supported shared CLI-helper surface for `@bobsled-inc/entity-graph`.
- **Dependency allowlist.** `@bobsled-inc/model-spec` may depend on `@bobsled-inc/protocol`, `@bobsled-inc/connections`, and `@bobsled-inc/project-index` and nothing else in the workspace. `connections` owns the integration schemas, secret resolution, and the SQL runner contract (including its cancellation half) — duplicating any of that here is the thing to avoid, not the dependency itself. `project-index` owns project file discovery: every project loader reads its files from the type index, never from a fixed directory.
  Specifically it must stay free of `@bobsled-inc/loader`, `@bobsled-inc/extractor`, `@bobsled-inc/bobsled-core`, and `@bobsled-inc/entity-graph`: the compiler must not acquire destination, extraction, or orchestration concerns. Cross-warehouse publishing is injected by the host via `RunProjectOptions.crossWarehousePublisher` precisely to keep that boundary.
  (An earlier revision of this file said "free of `@bobsled-inc/*` dependencies" outright. That was never true of the shipped package — `protocol` and `connections` have always been direct dependencies — so the rule is stated accurately here.)

---

Native `interchange.ossie` is inert metadata. Preserve it through native edits;
never execute preserved semantic definitions. Legacy `type: interchange`
companions remain inert and validated when present, but new OSI imports do not
create them.

## Package Architecture

```text
packages/model-spec/
├── src/
│   ├── commands/           # model + seed CLI handlers
│   │   ├── compile.ts
│   │   ├── run.ts
│   │   ├── test.ts
│   │   ├── validate.ts
│   │   ├── lineage.ts
│   │   ├── profile.ts
│   │   ├── init.ts
│   │   ├── models.ts
│   │   ├── seed.ts
│   │   └── common.ts
│   ├── compiler/
│   │   ├── codegen.ts
│   │   ├── dag.ts
│   │   ├── dialect.ts
│   │   ├── materializer.ts
│   │   ├── orchestrator.ts
│   │   ├── parser.ts
│   │   ├── schemas.ts
│   │   ├── expr/
│   │   └── seed/
│   ├── config.ts
│   ├── output.ts
│   ├── profiler/          # read-only table profiling, inferences, cleaning proposals
│   ├── shared.ts          # public shared helpers for @bobsled-inc/entity-graph
│   └── index.ts           # model CLI entry point
├── tests/
│   ├── cli/
│   ├── fixtures/specs/
│   └── unit/
└── README.md
```

---

## Public Surfaces

### Library exports

- `@bobsled-inc/model-spec`
  - modeling compiler/runtime APIs
  - seed helpers like `readCsv`
  - shared types such as `SupportedDialect`
- `@bobsled-inc/model-spec/shared`
  - config loading
  - structured output helpers
  - generic CLI option/context helpers
  - `CommandError`

### CLI binaries

- `bobsled model`

These binaries only expose modeling, profiler, and seed commands.

---

## CLI Commands

### Modeling

```bash
bobsled model compile [model...] [-o dir] [--integration <handle>] [--include-metadata]
bobsled model run [--integration <handle>] [--secrets path] [--dry-run] [--full-refresh]
bobsled model test [model...]
bobsled model validate [model...] [--no-strict]
bobsled model lineage [model...] [--integration <handle>] [--json] [--yaml] [--column <model.column>]
bobsled model profile <table> [--integration <handle>] [--json]
bobsled model profile suggest cleaning <table> [--integration <handle>] [--json]
bobsled model init <project-name>
```

### Seeds

```bash
bobsled model seed validate [--json]
bobsled model seed load [--runner ./r.js] [--json]
bobsled model seed diff --runner ./r.js [--json]
```

For Entity Graph commands, see:

- `packages/entity-graph/AGENTS.md`
- `docs/reference/advanced/entity-graph-authoring-guide.md`

---

## Working Rules

- Prefer extending declarative schemas over adding one-off imperative behavior.
- Agent loops inherit approved host tools when `execution.tools` is omitted. An explicit list restricts tools; an empty list disables extra tools. Keep `execution.tools` bound to assignment `allowed_tools` and checkpoint identity. Reject unsupported host tools before preparation; executor hosts own per-call authorization and execution.
- Agentic spend caps (`limits.max_cost_usd`, `limits.tokens`) are checked only before dispatch: at a cap, stop new work, let in-flight attempts finish, accept their answers, and fail with `spend_cap_reached`. Caps stay out of the run identity so a resume can raise them. Per-assignment limits are deprecated and ignored by spend-cap runs. Runs saved without `accounting: spend_cap` must keep the reservation rules on resume, in transitions and in `checkpointIsConsistent`. Keep unlimited checkpoints JSON-safe and preserve unknown usage.
- Agentic error messages must be safe to print: put the stable code first, add a `reason` and a `hint` when known, and attach host or storage errors only as `cause`. `formatAgenticError` prints causes that are not Bobsled Core errors by type, system code and numeric status only.
- Agentic model and executor contracts use the public `@bobsled-inc/model-spec/agentic` subpath. Keep provider SDKs out of this package and runtime callbacks out of serialized assignment payloads.
- Executor output tools use `createAgentAssignmentOutputSchema(assignment)` for the complete result envelope. Row count, group key values, evidence sources and prepared retrieval times must survive JSON Schema transport. Keep final `parseAgentAssignmentOutcome` validation for replacement-key membership, multi-row grain uniqueness, total data bounds and attempt identity.
- Agentic checkpoints use a DuckDB file per run or, without the driver, the shared `.bobsled/model-spec/run-state.json` lock and digest-named snapshots; a configured warehouse or DuckDB store; or an exclusive supplied-store session. Warehouse stores must fence owners and commit the snapshot pointer atomically. Keep acceptance separate from warehouse publication. Never save a stale whole-file state over current references.
- Warehouse state and cursor statements run on dedicated runners from `openLimitedRunner`, so every one has a server-side limit and a client deadline derived from the lease. Never pass `statementTimeoutMs` to model or publication runners. A timeout means `lease_lost` with reason `statement_timeout`: the session sends nothing more and keeps its lease, and recovery must wait `retryAfterMs` before it acquires. Driver text stays in `cause`.
- A warehouse checkpoint session may apply a command to the snapshot whose fenced pointer it committed or verified, and only while the pointer still names it. `read()` always verifies the durable payload, callers receive copies, and coordinators validate every store response.
- The row store's commit is the single fenced header update; rows it does not reach through `head` are orphans and must stay inert. Never read a write that is off the chain, never update a stored row, and never rely on a unique key: Snowflake, BigQuery and Databricks do not enforce them. New commands that change anything outside the header need a case in `agenticCommandItems`. Engine differences belong in `AgenticRowDialect`, not in `row-state.ts`, and a warehouse backend opens its session with `openLimitedRunner`.
- Group commit (`groupCommit` on the row store, an optional `checkpointMany` on a session) saves waiting starts and finishes with one header update. Each command keeps its operation ID and expected revision and is the same chained write it is alone, so the layout does not change. Make a call only after its group's commit is confirmed. A group may only accept: a command the transition refuses goes alone, and a group the store saved none of goes one command at a time. `oneAtATime` in `schedule.ts` must keep behaving exactly as before. See `docs/agentic-group-commit.md`.
- A warehouse `checkpoint_store` selects the warehouse store; `createWarehouseRowStore` is opt-in through `agentic.stateStore`. Do not change that default without an explicit decision. A new cursor key reads `__bobsled_cursors` until its value lands. Establish that the table is absent before treating the key as new: a failed read must never restart a key's progress.
- A run's header lives in the table its hash picks from `dialect.headerTables`, and it stays there. Anything that reads or changes headers goes through the run's `runs` table, or through `agenticHeaderTableNames` when it must reach every run, never through `AGENTIC_RUNS_TABLE`. Add a size at the front of `headerTables` and keep the old ones: a size that leaves the list strands the runs in it. A first header must check the run's table in every other listed set in the same atomic step (`insertIfAbsent`'s `absentFrom`), or two openers can give one run two owners; an engine that cannot do that lists one set.
- A cursor row at version -1 is waiting for its carried record. Never read its empty record as no progress, and never put a record in a first row: it lands afterwards as a bound update.
- The Snowflake row dialect adds a first row in one `EXECUTE IMMEDIATE` submission: update the single row of `__bobsled_agentic_guard`, check `SQLROWCOUNT`, then count, then insert. The `UPDATE` is what serializes concurrent scripts, and only the statements after it see what they committed. Values in that script are literals, quoted twice, so keep them small. Read rows changed from the update's result and fail the write when it is missing. Keep each statement under 1 MB including bound values, counting three bytes per UTF-16 unit. Verify with `cloud-row-store.test.ts`; the emulator proves logic, not Snowflake.
- DuckDB state tables have no keys or indexes: a key makes a file opened per operation grow on every close. A process must never open and close a DuckDB file while another of its instances holds that file, because POSIX then drops the process's file lock. Go through `withDuckDbFile`, use the run's lock file, not DuckDB's lock, as local ownership, and keep a DuckDB `checkpoint_store` off a model's target file, which hosts read outside that guard. Open a state file with `isolated`, and never open a model's target that way: a target's views can legitimately read files.
- A store's `limits` say what it holds. The snapshot schema accepts `AGENTIC_MAX_STORE_LIMITS`, the most any store declares, so every store checks its own: `applyAgenticCheckpoint` holds a run to the defaults, the row store passes its dialect's limits to `applyAgenticCheckpointWithin`, the file and warehouse stores check theirs on read and save, and the coordinator passes `agenticCheckpointLimits` to every receipt. Only a row dialect declares more than the defaults, and only after a measurement on that engine: on Snowflake, `agentic-row-limits.bench.test.ts` builds most of a large run in bulk, because driving every assignment there takes hours. Read bounds derive from the store's limits through `agenticStoredBounds`, and every statement of a load that fetches rows is held to what they have left. One assignment stays at `AGENTIC_MAX_ROWS` rows whatever a run holds.
- Run-loop work per checkpoint must not grow with the run: `checkpoint-growth.bench.test.ts` fails if it does, and `row-store-growth.bench.test.ts` fails if resuming a row-store run, or checkpointing it late, stops being flat up to the row limit. Work that reads the whole run blocks the event loop, so a row session renews its lease before it and between the statements of a long read. `checkpoint-verified.ts` proves `start_attempt` and `finish_attempt` against a verified, deeply frozen snapshot. A proof may only accept; everything else takes the complete check, which decides and reports. A new snapshot rule must reach the proof: put a per-work rule in `checkpoint-work.ts`, and give a rule that reads other work items an index in `VerifiedFacts`. Never let frozen state hold a caller's objects or reach hosts: copy first. A store stays flat by keeping what `applyAgenticCheckpoint` returned and returning it, as the row store does.
- Explicit failed-assignment retries must be recorded in an execution window before dispatch. Preserve accepted work, attempt history, charges, and limits. Derive assignment progress only from validated checkpoints; observer failures must not cause model calls or change saved state.
- Incremental agentic inputs reserve a shared model cursor before preparation. Freeze cursor values with the inputs; advance only after confirmed publication. Failed batches retain their run ID reservation for resume. A new start may take over unpublished work only after exclusively acquiring and durably superseding the old checkpoint, then comparing and swapping cursor ownership. Never take over a prepared or confirmed publication; resume it to reconcile its receipt. Never use output row timestamps as progress, and never fall back to local cursors for a supplied checkpoint store.
- DuckDB agentic publication opens and closes a dedicated runner for each operation under a canonical-file-path guard. Hosts must exclude other independent live DuckDB instances and external writes to managed targets during publication; separate live instances can retain stale catalog views. Keep target revision/fence checks and the receipt in the same target transaction.
- Agentic publication reuses the shared materializer SQL. Keep each target change and receipt in one transaction submission for Snowflake, BigQuery, and Databricks; a reconnect between statements must not split the commit. PostgreSQL uses one dedicated connection.
- A publication without processed keys leaves its target unchanged. Check an existing target in place only when every column's type and collation match the probe stage from the same run's preflight; otherwise stage it. Only PostgreSQL establishes column collations through its information schema, so other warehouses stage no-ops. Keep the schema assertion, row limit, final checks, manifest, fenced version bump and receipt.
- Configured warehouse checkpoint schemas also name the built-in warehouse publication schema in the output catalog. Keep target introspection on the output schema and bind the publication schema to run identity.
- Snowflake ownership assertions contain scalar subqueries. Assign their result with `matches := (SELECT ...)`; `SELECT ... INTO` fails for this query shape. Verify changes with the opt-in cloud checkpoint and publication integration suites.
- Deployed model analysis accepts SQL and agentic models. Query-time DuckDB planning rejects any requested closure containing an agentic model; it must use the agentic runtime. Unrelated SQL closures remain queryable.
- Keep compiler code dialect-aware and deterministic.
- Preserve backward compatibility for existing model and seed specs unless a migration path is documented.
- **Cancellation is a first-class execution concern.** Any new asynchronous warehouse boundary reachable from `runProject` must accept and forward the run's `AbortSignal`. Concretely:
  - Take the signal as an optional trailing parameter and forward it to the runner as `SqlExecOptions` (`run(sql, { signal })`, `query(sql, params, { signal })`).
  - When no signal is supplied, call the runner with its ORIGINAL arity — do not pass a trailing `undefined`. Custom `--runner ./r.js` modules and existing tests observe call shape, and the no-signal path must stay byte-identical.
  - Guard loops with `throwIfCancelled(signal)` before each iteration so nothing new starts after an abort.
  - Re-raise cancellation instead of folding it into a best-effort warning or a `status: 'failed'` result — use `isCancellationError(err)` to tell them apart. A cancelled statement must never advance run state.
    These are enforced by `tests/unit/compiler/executor-cancellation.test.ts` and `tests/unit/api/run-project-cancellation.test.ts`; extend those when you add a boundary.
- If a change is needed by both `model-spec` and Entity Graph, prefer promoting it into a stable export instead of importing across package source trees.
- When adding shared helpers for Entity Graph, export them from `src/shared.ts`; do not import `src/commands/common.ts` from another package via relative paths.

---

## Common Change Types

### Add a new modeling feature

1. Update the relevant Zod schema in `src/compiler/schemas.ts`.
2. Update parsing/normalization in `src/compiler/parser.ts` or sibling modules.
3. Add dialect-aware SQL generation in `src/compiler/codegen.ts` or helper modules.
4. Add unit coverage plus CLI coverage when behavior is user-visible.

### Add or adjust seed behavior

1. Update `src/commands/seed.ts` and `src/compiler/seed/*` helpers.
2. Keep CSV parsing/export deterministic and machine-readable.
3. Add regression coverage in `tests/unit/` and CLI coverage if output changes.

### Add or adjust profiler behavior

1. Keep warehouse access read-only. `src/profiler/profile.ts` owns `COUNT(*)`, bounded sample SQL, confidence filtering, and target sample orchestration.
2. Keep inference modules pure under `src/profiler/inferences/`; they accept sampled rows and return deterministic confidence/evidence payloads.
3. Use named contracts from `src/profiler/types.ts` for report, row, FK target, anomaly, and cleaning payloads.
4. Preserve output discipline: `--json`, CI/non-TTY, and `BOBSLED_CORE_OUTPUT_FORMAT=json` must emit machine-readable output and suppress human logs. If the JSON output is an agent-consumable command result or export, add equivalent `--yaml` output too.
5. Add focused coverage in `tests/unit/profiler/` and `tests/cli/profile.test.ts`.

### Add shared helpers for Entity Graph

1. Keep the implementation in existing `model-spec` modules.
2. Re-export only the stable API from `src/shared.ts` or `src/compiler/index.ts`.
3. Add a test in the owning package and, when relevant, a consumer test in `packages/entity-graph/`.

---

## Testing

- Run `pnpm --filter @bobsled-inc/model-spec test:unit` for package-scoped work.
- Run `pnpm --filter @bobsled-inc/model-spec build` after changing exports.
- If you touch shared helpers consumed by Entity Graph, also run `pnpm --filter @bobsled-inc/entity-graph test:unit`.
- Before PR, prefer the repo gate: `pnpm precommit`.

---

## Pointers

- **Modeling walkthrough**: `packages/model-spec/README.md`
- **Profiler quick start**: `packages/model-spec/docs/profiler-quickstart.md`
- **Profiler user guide**: `packages/model-spec/docs/profiler-user-guide.md`
- **Profiler agent skill**: `.agents/skills/model-profiler/SKILL.md`
- **Shared helper surface**: `packages/model-spec/src/shared.ts`
- **Entity Graph package guide**: `packages/entity-graph/AGENTS.md`
- **Multi-dialect support**: Every codegen function must produce valid SQL for all 6 canonical dialect families (Snowflake, BigQuery, PostgreSQL, DuckDB, Databricks, MySQL) and compiler targets (`pgvector`, `redshift`)
- **Quoting**: Always use `quoteIdentifier()` and `quoteLiteral()` from `dialect.ts` — never raw string interpolation
- **Type safety**: All spec fields validated by Zod schemas before codegen
- **Output tables**: Fixed schemas — never add columns without updating `output-tables.ts`
- **Append-only tables**: `__review_decisions`, `__not_match_edges`, `__golden_record`, `__golden_history`, `__survivorship_audit`, `__split_events` use `CREATE TABLE IF NOT EXISTS` — never `CREATE OR REPLACE`

Agentic host wrappers preserve native `Error.cause`. Failed native model execution results retain a non-enumerable `cause` for library callers; JSON results and checkpoints do not include it. The consuming host owns redaction and terminal error reporting.
