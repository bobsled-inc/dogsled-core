# Agentic output publication

Agentic models use the same selected integration and target names as derived models.
Built-in agentic publication supports five database integrations: DuckDB, PostgreSQL,
Snowflake, BigQuery, and Databricks. The shared materializer builds the replacement
SQL. A publication coordinator keeps commit receipts and handles restart recovery.

A processed key means the agent completed that input. Replace all old rows for that
key with its new rows. If it produced no rows, delete its old rows. Keep rows for
keys that were not processed. Empty input leaves the target unchanged, including
leaving an absent target absent. Untouched rows keep their metadata.

MySQL, Redshift, and pgvector are compiler targets. Dogsled does not yet ship built-in
integration runners for them. This change does not add those integrations.

## Public API

Use the existing `@bobsled-inc/model-spec/agentic` entry point:

```typescript
import {
  createSqlAgenticPublisher,
  executeAgenticRun,
  resolveAgenticModel,
} from '@bobsled-inc/model-spec/agentic';

const publisher = await createSqlAgenticPublisher(integration);
try {
  const result = await executeAgenticRun(
    host,
    {
      resolved: resolveAgenticModel(model, host),
      integration: 'lake',
      target: 'main.pair_assessments',
      inputRef: 'undecided_pairs',
    },
    {
      projectDirectory,
      run: { id: savedRunId, mode: 'start' },
      publisher,
      // stateStore: suppliedStore,
    }
  );
  // result.publication === 'confirmed'
} finally {
  await publisher.close();
}
```

`AgenticHost` supplies `inputs`, `platform.models`, `prepare`, `executeAgent`,
and `supportedDialects`. Prefer YAML limits; `tokensPerAssignment` is an optional
legacy fallback. Preparation must honor the row,
byte and cancellation bounds passed in its context. The executor may be a fake or
a trusted caller implementation. This API does not load a provider SDK or a CLI
executor. Without a publisher, `executeAgenticRun` still returns pending execution.

For a mixed model graph, pass the host. Dogsled selects and closes a publisher for each model:

```typescript
await runProject(projectDirectory, {
  agentic: {
    run: { id: savedRunId, mode: 'start' },
    host,
  },
});
```

You can still supply `agentic.publisher`. In that case, the caller owns its lifetime.
The standalone factory also requires the caller to close the publisher. Derived models
before and after the agentic model use the regular runner. Downstream models start
only after confirmation. A supplied regular `state` also requires a supplied
`agentic.stateStore` or a configured `checkpoint_store` in `model-spec.yml`. The old `experimentalAgenticProbe.publish` callback remains
a test seam; it cannot confirm durable publication.

## Transaction and ownership

All adapters use shared processed-key SQL from the regular materializer module.
The stage contains untouched target rows plus the new accepted rows. Old target
rows stay in the database. They are not loaded into JavaScript. The target update
and receipt commit together. A separate processed-key relation supports zero findings.

| Database   | Commit procedure                                            | Requirement                                                     |
| ---------- | ----------------------------------------------------------- | --------------------------------------------------------------- |
| DuckDB     | Dedicated connection transaction                            | Writable local file; exclusive access from other live instances |
| PostgreSQL | Dedicated connection transaction                            | Table and schema write permissions                              |
| Snowflake  | One scripting block with a transaction and rollback handler | Table and schema write permissions                              |
| BigQuery   | One multi-statement transaction job                         | Dataset and table write permissions; one compatible location    |
| Databricks | One `BEGIN ATOMIC` block                                    | Unity Catalog managed tables with catalog commits enabled       |

Databricks catalog commits are a Beta feature. Preflight checks table features and
executes a multi-table transaction before agent work. Existing target tables must
already have this feature. Dogsled does not upgrade them. See the
[Databricks requirements](https://docs.databricks.com/aws/en/transactions).

Snowflake, BigQuery, and Databricks cannot create permanent tables inside this
transaction. Therefore, a failed first publication can leave an empty target table.
It cannot leave part of the new result rows. Existing targets keep all old rows if
the transaction fails. PostgreSQL uses the same generic setup procedure; DuckDB
also creates the first target inside its transaction.

Each target has a revision and an owner fence. A new claim changes the fence.
Commit advances the revision only for the expected revision and current fence.
The generic adapters also check a fresh commit token inside the transaction. This
proves the update happened in this attempt, even if a caller reuses a claim.
A stale stage cannot overwrite a newer publication. A repeated committed operation
reads its exact receipt and makes no further change.

Snowflake, BigQuery, and Databricks submit each transaction as one statement or job.
This avoids reconnecting between BEGIN and COMMIT. PostgreSQL uses one dedicated
connection. Custom runner factories must preserve these semantics and must not
replay writes after an unknown response.

DuckDB keeps its existing file guard. Each operation opens and closes a runner
under a guard keyed by the canonical file path. The host must exclude independently
opened DuckDB instances while publication runs. Network file systems and shared
multi-host DuckDB files are outside this contract.

For every database, the host must prevent external writes and schema changes to
managed targets, stages, and control tables during publication. This includes
manual SQL and other writers that do not use the publication coordinator.

Execution ownership stays held through state confirmation. The coordinator checks
that ownership again before claims, intent storage and publication. A supplied
store must keep the session exclusive for the whole operation, including warehouse
calls; it must not transfer ownership while a protected call is in flight. A
warehouse fence rejects a superseded warehouse owner, but it is not an atomic
transaction with the state store. Checking a lease immediately before COMMIT cannot
close that cross-store gap. Hosts with renewable distributed leases must provide
an equivalent ownership guarantee before using this adapter.

## Checks and schema policy

Preflight runs under the saved run deadline and exclusive state session. It checks
bindings, target schema, final-check SQL, and transaction support before agent calls.
It creates the destination schema if needed for the generic adapters. DuckDB
requires an existing target schema. An existing target must match the output column
order, names, types, and nullability. A mismatch requires an explicit rebuild.
There is no automatic schema migration.

The adapter maps scalar types to the database's native types. Structured values use
JSON in DuckDB and BigQuery, JSONB in PostgreSQL, and VARIANT in Snowflake and
Databricks. Identifiers use the shared dialect quoting helpers. Result rows and
receipt payloads use parameter bindings. Commit scripts copy the saved receipt from
stage metadata; they do not embed result values in SQL.

Final checks run against retained staging. They enforce declared non-null columns,
unique non-null grain, prepared-key membership for new rows, and authored checks.
The adapter reuses the model test and expectation SQL generators. Supported tests
are `not_null`, `unique`, and `accepted_values`, with their required column and
values. Supported expectations are `primary_key`, `non_null`, `unique`, `in_range`,
`regex`, `schema_contains`, `row_count_between`, and `accepted_values`. All supported final
checks gate publication. Warning-severity expectations are rejected at preflight;
the first publisher contract has no warning result channel.
Custom SQL tests and custom or expression expectations are rejected before agent
calls. Missing fields and unknown referenced output columns are also rejected.
Each authored rule runs independently, including repeated tests on the same column.
Preflight executes generated check SQL against an empty typed scratch relation.
It then removes that relation. A bound scalar probe validates each regex with the
selected database even if an empty scan would skip evaluation. Invalid dialect
syntax or incompatible column types fail before agent calls. Preflight validates
SQL capability, not whether an empty sample satisfies the authored rule.
Check queries return one violation count with a two-row limit; malformed or failed
results leave the target unchanged and retain the stage.

## Recovery and cancellation

`AgenticPublicationIdentitySchema`, `AgenticPublicationIntentSchema` and
`AgenticPublicationReceiptSchema` define the saved contracts. They bind the run,
frozen definition, target, output schema, accepted results, explicit processed keys,
operation ID, stage and expected target version. The confirmed version advances
exactly once. Matching only an operation ID never proves success.

Version-1 snapshots with `publication: 'pending'` remain readable. Two atomic
checkpoint commands add `prepared` and `confirmed` publication states. Supplied
stores must apply the current `applyAgenticCheckpoint` function under their own
atomic write. Uncertain checkpoint responses are checked against the complete
expected snapshot.

Resume with the same run ID and `mode: 'resume'`. Accepted assignments are not
repeated. If an intent exists, the runner inspects its exact warehouse receipt
before attempting publication. This recovers a crash after target COMMIT but before
local confirmation. A receipt can confirm an already committed operation after the
current deadline. An explicit retry of pending publication saves a fresh execution
window before it tries to publish again. It still checks existing receipts first.
Retries never reset token limits or accepted results. A stale prepared target version requires a new
run after inspection; the runner does not silently rebase its stage.

Cancellation is forwarded to warehouse calls. If COMMIT's response is lost or
cancelled, the coordinator inspects the receipt without the cancelled signal before
deciding the result. It never treats an unknown response as proof of rollback.
A confirmed commit is saved even when cancellation happened near COMMIT; cancellation
still stops the caller and downstream dispatch. If receipt inspection itself fails,
publication remains unconfirmed and resume is required.

## Retention and limits

The adapters retain stages after failures, uncertain responses, and success.
The default limit is 32 manifests: per database for DuckDB, per target for the other
adapters. Incomplete stages count toward the generic adapter limit. Each full stage
can contain at most 1,000,000 rows by default, including untouched rows.
`maxRetainedStages` accepts 1–1,024. `maxStageRows` accepts 1–10,000,000.
New rows and processed keys are bounded by what the run's state store holds, as its
input is: see [row store limits](agentic-state.md#row-store-limits).
The host must also enforce a database disk quota. There is no automatic expiry.

DuckDB stores private tables in `_bobsled_agentic_publication`. The other adapters
store private tables beside the target by default, with names that start with
`_bobsled_pub_`. A configured checkpoint schema overrides that schema name within
the output database/catalog; see [warehouse checkpoints](agentic-state.md#warehouse-checkpoints).
This keeps BigQuery data in the selected dataset and Databricks data in the selected
catalog and schema. Stage names use bounded operation digests.

To clean up, stop writers and back up database and execution state. Remove only
confirmed, no-longer-needed stage tables, processed-key tables, and their manifest
rows. Keep receipts and target control tables for the full recovery period. Do not
remove a pending stage needed for retry. There is no broad cleanup command.

## Host tools

An `agent_loop` step can request tools from its host executor:

```yaml
execution:
  mode: agent_loop
  tools: [web_search, web_fetch]
```

These names do not refer to Dogsled sources. Dogsled carries them in the assignment's
optional `allowed_tools` field. The host declares `supportedTools` when it creates
its agentic host. Dogsled rejects unsupported names before preparation. A direct
`llm_call` cannot request tools. When `tools` is omitted, an agent loop uses the host's
approved `supportedTools`. An explicit list restricts access. Use `tools: []` to
disable extra tools. A host with no declared tools provides no extra tools.

The host owns each implementation, its credentials, permission checks, cancellation,
call limits, and audit records. Declaring a tool does not grant permission. Executors
must expose and dispatch only declared, permitted tools, and must fail if a requested
tool is unavailable. Dogsled does not execute host tools or verify their provider calls.

Tool evidence uses the declared tool name as `source`, a returned reference as
`reference`, and the tool's actual retrieval time as `retrieved_at`. Hosts that need proof of retrieval must check these claims against tool results.
Dogsled validates the evidence shape and allowed name; it does not prove that a URL was fetched. Saved tool declarations are part of
checkpoint identity. Changing the effective selection, including host defaults, requires a new run.
Resume rejects a changed selection instead of granting new tools silently.
