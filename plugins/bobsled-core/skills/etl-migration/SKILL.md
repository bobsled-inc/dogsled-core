---
name: etl-migration
description: Migrate, wrap, or modernize an existing ETL into Bobsled Core. Use when
  an agent needs to audit an existing scheduled data job, map it to Bobsled Core
  YAML, preserve cursor and destination safety, decide whether to keep the old
  orchestrator or use bobsled runner, and validate cutover without data loss.
---

# ETL Migration

Use this skill when moving an existing ETL, cron job, Airflow DAG, warehouse copy, or hand-authored workflow into Bobsled Core.

Use `extract-pipelines` as the authoritative capability and operating contract
for every extract pipeline produced by the migration.

## Orient

Read only what matches the task:

- Agent guide: [Run pipelines](https://github.com/bobsled-inc/bobsled-core/blob/main/docs/guides/run-pipelines.md)
- Data quality contracts: [Data tests and contracts](https://github.com/bobsled-inc/bobsled-core/blob/main/docs/reference/advanced/data-tests-and-contracts.md)
- Local pipelines: use the `pipeline` skill
- Scheduled runner: [Run pipelines](https://github.com/bobsled-inc/bobsled-core/blob/main/docs/guides/run-pipelines.md) and [Project files](https://github.com/bobsled-inc/bobsled-core/blob/main/docs/reference/project-files.md)
- Extraction specs: [Extractor reference](https://github.com/bobsled-inc/bobsled-core/blob/main/packages/extractor/README.md)
- Loading specs: [Loader reference](https://github.com/bobsled-inc/bobsled-core/blob/main/packages/loader/README.md)
- Model validation and expectations: [Model Spec reference](https://github.com/bobsled-inc/bobsled-core/blob/main/packages/model-spec/README.md)
- Pipeline repo operations: the Project guide and `bobsled-troubleshoot`

## Migration Workflow

1. Inventory the current ETL:
   - source system, selected objects, filters, and incremental cursor
   - destination tables, schema, load strategy, primary keys, and table naming
   - schedule, retries, alerts, owners, SLA, and failure behavior
   - existing quality gates: dbt tests, SQL assertions, freshness checks, schema checks, row-count reconciliations, and alert thresholds
   - secrets and where they are stored
   - transforms that must stay outside Bobsled Core for now

2. Choose the adoption shape:
   - Keep the old orchestrator and call `bobsled pipeline` when the scheduler must stay in place.
   - Use `bobsled.yml` and local `bobsled runner run` calls from the existing scheduler.
   - Use inline resource `extract:` and `load:` blocks for warehouse-to-warehouse jobs.
   - Keep billable extract plans and extract-intents in explicit caller orchestration.

3. Map the config:
   - integration handle and auth env vars
   - an explicit non-empty `resources:` allowlist; never translate legacy
     selection into unsupported `only:` or `exclude:` keys
   - destination config, schema/dataset/bucket prefix, `table_prefix`, and `load_strategy`
   - cursor field and primary key needed for durable incremental `merge`
   - the Bobsled Core validation layer for each old quality gate: extract validation, mock verify, scaffold-test, load check, model tests, model expectations, clean spec compilation, or strict runner validation
   - data-test and contract mappings from [Data tests and contracts](https://github.com/bobsled-inc/bobsled-core/blob/main/docs/reference/advanced/data-tests-and-contracts.md), especially which checks remain SQL-only versus executable JSON gates
   - semantic context files only if the task includes model, query, or agent data understanding

4. Protect the existing ETL:
   - test against a disposable destination, schema, bucket prefix, or table prefix
   - never commit raw secret values
   - do not overwrite old state or old destination tables during validation
   - keep rollback simple: re-enable the old scheduler and disable the caller’s Bobsled Core job

5. Validate before cutover:
   - use the checks supported by the Bobsled Core branch or release in hand; if a command is not available yet, keep the equivalent old check external and document the gap
   - `bobsled extract validate --semantic-check=strict`
   - `bobsled extract verify <integration> --mock` when fixtures or generated specs are in play
   - `bobsled extract scaffold-test <integration>` when live credentials are available
   - `bobsled load check --dest <destination> ...`
   - `bobsled model validate --integration <handle> --semantic-check=strict` when Model Spec models are in scope
   - `bobsled model test --integration <handle>` when model `tests:` blocks are present
   - `bobsled model expect run --integration <handle>` to compile `expect:` sentinel SQL
   - `bobsled model expect run --integration <handle> --runner ./runner.js --json` when an executable query runner is available
   - `bobsled clean validate <spec.yml>` and `bobsled clean apply --spec <spec.yml> --dialect <dialect> --json` when cleaning specs are in scope
   - `bobsled runner validate` for `bobsled.yml`
   - `bobsled runner run <pipeline> --resource <resource>` only after the destination is safe
   - compare counts, schemas, primary keys, representative rows, and translated assertions against the old ETL

6. Cut over:
   - pause the old schedule
   - run Bobsled Core once with the intended destination and state behavior
   - inspect local command logs and loaded data
   - document the owning Bobsled Core files and rollback command in the pipeline repo
   - remove the old job only after one or more successful scheduled runs

## State Rules

- Local extractor state lives under `.extractor/`.
- Keep durable extractor state in the configured local state location or caller-supplied checkpoint store.
- Prefer `--full-refresh` into isolated tables for the first production comparison.
- Do not copy old scheduler cursors into Bobsled Core state unless you can prove the cursor semantics and resource names match.
- For fan-out runs, Bobsled Core commits extractor state only after every destination load succeeds.

## Output Expectations

When handing off, include:

- chosen adoption shape and why
- files changed or proposed
- required secrets and whether values were added
- validation commands run and the result
- old quality gates mapped to Bobsled Core checks, plus any gaps that still run outside Bobsled Core
- cutover and rollback instructions
