---
name: etl-migration
description: Migrate, wrap, or modernize an existing ETL into Dogsled. Use when
  an agent needs to audit an existing scheduled data job, map it to Dogsled
  YAML, preserve cursor and destination safety, decide whether to keep the old
  orchestrator or use dogsled runner, and validate cutover without data loss.
---

# ETL Migration

Use this skill when moving an existing ETL, cron job, Airflow DAG, warehouse copy, or hand-authored workflow into Dogsled.

Use `extract-pipelines` as the authoritative capability and operating contract
for every extract pipeline produced by the migration.

## Orient

Read only what matches the task:

- Agent guide: `docs/guides/run-pipelines.md`
- Data quality contracts: `docs/reference/advanced/data-tests-and-contracts.md`
- Local pipelines: `.agents/skills/pipeline/SKILL.md`
- Scheduled runner: `docs/guides/run-pipelines.md` and `docs/reference/project-files.md`
- Extraction specs: `packages/extractor/README.md`
- Loading specs: `packages/loader/README.md`
- Model validation and expectations: `packages/model-spec/README.md`
- Pipeline repo operations: the Project guide and `dogsled-troubleshoot`

## Migration Workflow

1. Inventory the current ETL:
   - source system, selected objects, filters, and incremental cursor
   - destination tables, schema, load strategy, primary keys, and table naming
   - schedule, retries, alerts, owners, SLA, and failure behavior
   - existing quality gates: dbt tests, SQL assertions, freshness checks, schema checks, row-count reconciliations, and alert thresholds
   - secrets and where they are stored
   - transforms that must stay outside Dogsled for now

2. Choose the adoption shape:
   - Keep the old orchestrator and call `dogsled pipeline` when the scheduler must stay in place.
   - Use `dogsled.yml` and local `dogsled runner run` calls from the existing scheduler.
   - Use inline resource `extract:` and `load:` blocks for warehouse-to-warehouse jobs.
   - Keep billable extract plans and extract-intents in explicit caller orchestration.

3. Map the config:
   - integration handle and auth env vars
   - an explicit non-empty `resources:` allowlist; never translate legacy
     selection into unsupported `only:` or `exclude:` keys
   - destination config, schema/dataset/bucket prefix, `table_prefix`, and `load_strategy`
   - cursor field and primary key needed for durable incremental `merge`
   - the Dogsled validation layer for each old quality gate: extract validation, mock verify, scaffold-test, load check, model tests, model expectations, clean spec compilation, or strict runner validation
   - data-test and contract mappings from `docs/reference/advanced/data-tests-and-contracts.md`, especially which checks remain SQL-only versus executable JSON gates
   - semantic context files only if the task includes model, query, or agent data understanding

4. Protect the existing ETL:
   - test against a disposable destination, schema, bucket prefix, or table prefix
   - never commit raw secret values
   - do not overwrite old state or old destination tables during validation
   - keep rollback simple: re-enable the old scheduler and disable the caller’s Dogsled job

5. Validate before cutover:
   - use the checks supported by the Dogsled branch or release in hand; if a command is not available yet, keep the equivalent old check external and document the gap
   - `dogsled extract validate --semantic-check=strict`
   - `dogsled extract verify <integration> --mock` when fixtures or generated specs are in play
   - `dogsled extract scaffold-test <integration>` when live credentials are available
   - `dogsled load check --dest <destination> ...`
   - `dogsled model validate --integration <handle> --semantic-check=strict` when Model Spec models are in scope
   - `dogsled model test --integration <handle>` when model `tests:` blocks are present
   - `dogsled model expect run --integration <handle>` to compile `expect:` sentinel SQL
   - `dogsled model expect run --integration <handle> --runner ./runner.js --json` when an executable query runner is available
   - `dogsled clean validate <spec.yml>` and `dogsled clean apply --spec <spec.yml> --dialect <dialect> --json` when cleaning specs are in scope
   - `dogsled runner validate` for `dogsled.yml`
   - `dogsled runner run <pipeline> --resource <resource>` only after the destination is safe
   - compare counts, schemas, primary keys, representative rows, and translated assertions against the old ETL

6. Cut over:
   - pause the old schedule
   - run Dogsled once with the intended destination and state behavior
   - inspect local command logs and loaded data
   - document the owning Dogsled files and rollback command in the pipeline repo
   - remove the old job only after one or more successful scheduled runs

## State Rules

- Local extractor state lives under `.extractor/`.
- Keep durable extractor state in the configured local state location or caller-supplied checkpoint store.
- Prefer `--full-refresh` into isolated tables for the first production comparison.
- Do not copy old scheduler cursors into Dogsled state unless you can prove the cursor semantics and resource names match.
- For fan-out runs, Dogsled commits extractor state only after every destination load succeeds.

## Output Expectations

When handing off, include:

- chosen adoption shape and why
- files changed or proposed
- required secrets and whether values were added
- validation commands run and the result
- old quality gates mapped to Dogsled checks, plus any gaps that still run outside Dogsled
- cutover and rollback instructions
