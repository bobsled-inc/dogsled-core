# Operate agentic models

<!-- last-reviewed: 2026-09-23 -->

Use this guide after [building an agentic model](../../guides/agentic-models.md). Keep the
model definition, executor version, run ID, checkpoint storage, and output
location together in your deployment records.

## CLI options

Run these options through `dogsled model run` or `dogsled model run`:

| Option                                 | Meaning                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| `--agent-executor <path\|typesafe>`    | Trusted local module exporting `executeAgent`, or built-in Jev executor       |
| `--agent-run-id <id>`                  | Explicit run identity; a new UUID is generated when omitted                   |
| `--agent-resume`                       | Resume the explicit run ID; requires `--agent-run-id`                         |
| `--agent-retry-failed`                 | With `--agent-resume`, retry assignments saved as not retryable               |
| `--agent-max-cost <usd>`               | Cost cap for this invocation; overrides `limits.max_cost_usd`                 |
| `--agent-tokens-per-assignment <n>`    | Deprecated; ignored by new runs                                               |
| `--agent-concurrency <n>`              | One to 64 active assignments; default 1                                       |
| `--agent-min-dispatch-interval-ms <n>` | Zero to 60,000 ms between assignment starts; default 0                        |
| `--agent-allow-billable-source <ref>`  | Allow paid source queries for this actual source ref; repeat for more sources |

Agent run options require `--agent-executor`. Use `--json` or `--yaml` for
structured command output. `--dry-run` inspects the plan without calling the
executor or publishing output. `model compile` generates SQL and rejects agentic
models; it is not the execution command for them.

Concurrency and spacing apply within one model run in one process. Spacing
includes retries, but does not rate-limit the internal calls of an agent loop or
other processes. Concurrency does not raise the run's spend cap, but it does
raise how far a run can go over the cap: work already in flight when the cap is
reached still finishes. See [limits](agentic-model-reference.md#limits).

Stopping a run with Ctrl-C, `kill`, a CI cancel, or a container stop cancels it
cleanly: no new work starts, active calls are stopped, and saved answers are kept.
The CLI prints the command to resume.

## Start, resume, or start fresh

Use an explicit ID when you need restart recovery:

```bash
dogsled model run +pair_assessments --integration local \
  --agent-executor ./executor.mjs --agent-run-id pairs-20260923 --json
```

To continue saved work, keep that ID and add `--agent-resume`:

```bash
dogsled model run +pair_assessments --integration local \
  --agent-executor ./executor.mjs --agent-run-id pairs-20260923 \
  --agent-resume --json
```

Dogsled reuses frozen inputs and accepted results for the agentic model. An
unfinished assignment starts again, including its whole agent loop. It does not
restore the loop's conversation or remote session. Calls that ran before a crash
but did not save their result may run and be billed again. Upstream and downstream
SQL still follow the regular model runner's rules.

An explicit retry gets a fresh execution timeout window. Spend and attempt
counts are preserved. The default is three attempts per assignment; library hosts
can set one to ten. Failed outcomes retry automatically only when marked retryable.
Automatic retries and lease recovery do not extend the current time window. To
retry an assignment that the executor marked as not retryable, fix the cause and
add `--agent-retry-failed` to the resume.

Spend caps may change between invocations: raise `limits.max_cost_usd` or
`limits.tokens`, or pass `--agent-max-cost`, and resume. Changed model
definitions, resolved profiles, timeouts, targets, input contracts, or
effective tool declarations conflict with a saved run. Start a new ID for changed
work. Reusing an ID does not start a new batch. Concurrency and dispatch spacing
can change on resume because they do not change assignment data.

For an incremental model, a fresh ID can take over an unfinished batch only when
Dogsled acquires the old checkpoint exclusively and permanently marks it superseded.
It keeps the last committed cursor, reads inputs again, and does not reuse the old
unpublished results. This can cost more than resume. A live owner blocks takeover.
A superseded run cannot resume or publish.

If the old run has prepared or confirmed publication, resume that run first.
Its write may already have succeeded. Dogsled checks the saved receipt instead of
assuming a lost response means rollback. Do not delete state to bypass this check.

## Incremental inputs

Add a cursor to a prepared input alias:

```yaml
sources:
  pairs:
    ref: candidate_pairs
    incremental:
      cursor_field: updated_at
```

The first batch reads all selected input. Each later batch reads rows whose cursor
is strictly greater than the last successfully published batch's cursor. Dogsled
freezes rows and their maximum cursor values together. The shared cursor advances
only after publication is confirmed, even when completed assignments return no
findings. Use a new run ID for each batch.

The cursor column must be a non-null number, integer, date, or UTC timestamp.
Hosts must retain timestamp precision. Rows arriving later with older or equal
cursor values are not selected. Deletions need an explicit input record. Each
input is filtered independently, so prepare complete groups upstream when later
steps need unchanged context rows too.

Cursors belong to prepared inputs, not sources used only for context reads.
Changing input references or cursor fields conflicts with saved progress and
requires an explicit migration. `--full-refresh` is rejected for incremental
agentic models; it is not a cursor reset command. There is no general CLI cursor
reset workflow. Plan a migration and preserve recovery records before changing
progress storage.

## What gets published

Publication replaces old rows for the complete set of processed keys. It preserves
rows for keys outside that set. The model's grain identifies output rows; its
materialization keys identify the records whose old findings should be replaced.

| Outcome                                     | Effect                                                               |
| ------------------------------------------- | -------------------------------------------------------------------- |
| All required assignments complete with rows | Replace findings for their processed keys                            |
| An assignment completes with no rows        | Remove old findings for its processed keys                           |
| Prepared input is empty                     | Successful no-op; an absent target stays absent                      |
| Required work fails or a final check fails  | No new findings are published                                        |
| Commit response is lost                     | Inspect receipt on recovery before deciding whether to publish again |

Publication waits for every step to complete. Downstream SQL starts only after
confirmation. An `insufficient_evidence` domain outcome can be completed work;
an execution failure or cancellation cannot be converted to a successful empty
answer. A failed first publication can leave an empty target on some databases,
but not partially committed new findings.

Existing target columns must match names, order, types, and nullability. Output
schema changes need an explicit rebuild or migration. Dogsled does not automatically
migrate the table.

## Storage and database support

| Output database | Built-in publication                    | Configured warehouse checkpoints        |
| --------------- | --------------------------------------- | --------------------------------------- |
| DuckDB          | Yes, persistent local file              | No; use local execution checkpoints     |
| PostgreSQL      | Yes                                     | Yes                                     |
| Snowflake       | Yes                                     | Yes                                     |
| BigQuery        | Yes                                     | Yes                                     |
| Databricks      | Yes, with required transaction features | Yes, with required transaction features |
| ClickHouse      | No                                      | No                                      |

SQL compiler support for another dialect does not imply agentic publication
support. BigQuery needs a compatible location for the transaction. Databricks
needs Unity Catalog managed tables with catalog commits enabled; preflight checks
transaction support before agent calls. See the [publication guide](../../../packages/model-spec/docs/agentic-publication.md)
for connection and transaction requirements.

By default, local execution checkpoints live under `.dogsled/model-spec/`: one DuckDB file per run
when `@duckdb/node-api` is installed, and JSON files otherwise. See
[where state is stored](../../../packages/model-spec/docs/agentic-state.md#where-state-is-stored).
Keep that directory on persistent local storage across restarts. Local locking supports one host, not
network file systems or several hosts. For DuckDB, keep the database file as well:
it contains output, receipts, and shared input cursors. Prevent independent live
DuckDB instances and external writers from changing managed targets during
publication.

For workers that move between machines, configure warehouse checkpoints in
`model-spec.yml`. `checkpoint_store` also accepts a
[DuckDB integration](../../../packages/model-spec/docs/agentic-state.md#duckdb-checkpoint-store),
and a library host can supply the
[warehouse row store](../../../packages/model-spec/docs/agentic-state.md#warehouse-row-store)
instead of this setting:

```yaml
checkpoint_store:
  integration: analytics_warehouse
  schema: track_checkpoints
  lease_seconds: 300
```

The integration must exist in the project. The default lease is 120 seconds; the
allowed range is 10–600 seconds. A longer lease can tolerate warehouse queues but
also delays recovery after a crash. Each checkpoint statement can be queued or run
for half the lease. After a longer one, Dogsled waits out the lease and retries up to
twice, then stops the run with `lease_lost (statement_timeout)`, which you can resume.
The lease does not extend the model timeout. An
invalid configured store fails; Dogsled does not silently fall back to local files.

The checkpoint schema needs schema/table creation, SELECT, INSERT, UPDATE, and
DELETE permissions. It contains frozen inputs, intermediate findings, accepted
results, and usage. Encoded checkpoint payloads are not encrypted by that encoding.
Apply your normal data access, encryption, and retention policies. A configured
checkpoint schema also names publication storage in the output database/catalog.
Final model output still uses its configured destination.

After lease loss, Dogsled cancels active work and can attempt recovery twice by
acquiring ownership and reloading saved state. It does not take a live lease from
another worker. Shared incremental cursors follow the checkpoint configuration;
a supplied store must provide cursor support or the host must supply a cursor store.

## Retention and cleanup

The file store permits 100 retained runs, 16 MiB per file, 2,000 directory entries,
and a 256 MiB directory budget. Warehouse snapshots are also bounded. Publication
retains stages after success and failure; defaults allow 32 retained manifests
(per database for DuckDB, per target for other publishers) and 1,000,000 rows in
a full stage, including untouched rows. Host APIs can set bounded overrides.

Runs saved as rows expire, in DuckDB and in the opt-in
[warehouse row store](../../../packages/model-spec/docs/agentic-state.md#warehouse-row-store):
Dogsled removes a run 30 days after its last write unless it is still owed publication or cursor
recovery. That includes failed runs, so one resumed after that starts again. A DuckDB
`checkpoint_store` can change the period with `retention_days`. See
[the row layout](../../../packages/model-spec/docs/agentic-state.md#row-layout).

Nothing else expires automatically, and there is no broad cleanup command. Stop writers, back up
state and database storage, and retain pending runs, referenced snapshots, receipts, and
control tables for your recovery period. Remove only artifacts proven unnecessary.
See [checkpoint cleanup](../../../packages/model-spec/docs/agentic-state.md#local-files-ownership-and-retention)
and [publication retention](../../../packages/model-spec/docs/agentic-publication.md#retention-and-limits)
for the storage-specific rules.

## Troubleshooting

| Symptom                                             | Check and next step                                                                                 |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Agentic host required                               | Supply `--agent-executor`, or `agentic.host` in the library API                                     |
| Model profile missing                               | Match `llm.profile` to a role under `platform.models`                                               |
| Input or output limit exceeded                      | Reduce the selected workload upstream; do not truncate a group or advance past omitted rows         |
| `spend_cap_reached`                                 | Raise the cap and resume; saved answers are kept and not repeated                                   |
| `estimate_exceeds_cap`                              | The first step's input alone is over the cap; raise it or select fewer rows                         |
| `pricing_unknown`                                   | No built-in price for the model; use `limits.tokens` as the cap instead                             |
| Assignment failed after N attempts                  | Read the error kind and code in the message; fix the cause, then follow the printed hint            |
| `auth` error `auth_failed`                          | Fix the profile's API key, then resume with `--agent-resume --agent-retry-failed`                   |
| `run_in_progress`                                   | Another process still runs this ID; wait for it or stop it, then resume                             |
| `source_access_denied`                              | The executor kept requesting a source or operation the step does not allow; check `context_sources` |
| `too_many_rows`, `row_too_large`, `batch_too_large` | The message names the input and limit; select fewer rows, or use an incremental input               |
| `cursor_tie_too_large`                              | Use a cursor field with more distinct values, such as a higher-precision timestamp or an ID         |
| "More rows are waiting"                             | An incremental run processed one batch; run the model again for the next one                        |
| Checkpoint conflict                                 | Restore the matching definition/settings, or start a new run for the new definition                 |
| Cursor busy or active owner                         | Wait for the owner or resume its run; a fresh start cannot take a live lease                        |
| Old run must resume                                 | Reconcile its prepared/confirmed publication before another batch starts                            |
| Source or tool denied                               | Check aliases, `context_sources`, host `supportedTools`, and paid-source approval                   |
| Target schema mismatch                              | Plan an explicit target migration/rebuild and a fresh run                                           |
| Final check fails                                   | Inspect retained stage findings and the authored check; the old target remains intact               |
| Supplied regular state requires a checkpoint store  | Configure `checkpoint_store` or supply `agentic.stateStore`                                         |
| Skills or cross-warehouse settings rejected         | These schema fields are not implemented by the current mixed runner                                 |

Keep raw provider errors and source responses out of public logs. For custom hosts,
trusted diagnostic causes may contain private data; remove sensitive details before
logging them. The [host guide](../../../packages/model-spec/docs/agentic-hosts.md) explains
which checks belong to the executor and source adapter.
