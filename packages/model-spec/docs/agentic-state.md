# Agentic execution state and restart

Dogsled saves agentic checkpoints under the project `.dogsled/model-spec` directory by default.
A supplied `AgenticStateStore` replaces all local agentic storage. Execution state
needs no warehouse or database service. See [where state is stored](#where-state-is-stored)
for how a run's store is chosen.

The bounded execution API supports ordered map/reduce plans with `llm_call` or
`agent_loop` steps and a supplied executor. Without a publisher it returns accepted output with `publication: 'pending'`.
With a publisher it holds ownership through durable confirmation. See
[Database publication and recovery](agentic-publication.md) for the API and ownership
contract. A loop retry starts the whole assignment again. It does not restore
an internal conversation or remote session.

## Start and resume

Use the public `@bobsled-inc/model-spec/agentic` exports:

```typescript
import { executeAgenticRun, resolveAgenticModel } from '@bobsled-inc/model-spec/agentic';

// host supplies input schemas, profiles, tokensPerAssignment, prepare and executeAgent.
// model is a validated AgenticModelSpec.
const context = {
  resolved: resolveAgenticModel(model, host),
  integration: 'lake',
  target: 'main.pair_assessments',
  inputRef: 'undecided_pairs',
};
const result = await executeAgenticRun(host, context, {
  projectDirectory,
  run: { id: savedRunId, mode: 'start', scope: 'my-project' },
  maxAttempts: 3,
});

// In another process, use the same directory, scope, model and run ID.
const recovered = await executeAgenticRun(host, context, {
  projectDirectory,
  run: { id: savedRunId, mode: 'resume', scope: 'my-project' },
  maxAttempts: 3,
});
```

The host must retain the run ID. The default scope is the integration handle.
Each scope, model name and run ID identifies one run. Changed definitions,
resolved profiles, targets, input contracts or limits cause a conflict.
A repeated start with the same identity opens that run; use a new ID for new work.
An explicit resume fails if the run is missing.

Dogsled saves the definition and initial deadline before input preparation. An
explicit retry of unfinished work saves a new execution window before it continues.
Each window has the model's full `limits.timeout_seconds` allowance, measured from
the new invocation. This also applies when `mode: 'start'` opens an existing run.
Once preparation is sealed, the saved assignments contain the frozen input rows. Resume uses those
rows and does not query the input source again. Input source changes after sealing
do not change this run. There is no reuse between different run IDs.

Before an executor call, Dogsled saves the attempt with its input estimate as a
charge. It saves verified usage and an accepted result together. An interrupted
call keeps its estimated charge. A retry starts the whole assignment with a new
attempt ID. It does not reconnect a remote session. Accepted assignments never
run again. Failed outcomes retry automatically only when `error.retryable` is true. A thrown
executor error stops the current invocation; a later resume can retry it.

### Retry a saved terminal failure

After fixing the cause, a host can explicitly retry work saved with
`error.retryable: false`:

```typescript
await executeAgenticRun(host, context, {
  projectDirectory,
  run: { id: savedRunId, mode: 'resume', scope: 'my-project' },
  retryFailedAssignments: true,
});
```

Set this option only for an explicit retry request. Ordinary resume and repeated
start keep their existing behavior. The option requires `mode: 'resume'`.
Dogsled saves the request in the execution window before it calls the executor.
It permits a new attempt after an earlier terminal failure. If that attempt also
returns a terminal failure, the invocation stops again. It does not loop.

This keeps accepted answers, frozen inputs, usage charges, and attempt history.
It does not reset token or attempt limits, override excess usage, or change
publication and cursor rules. An assignment with no attempts left still cannot
run. The caller must fix errors such as invalid credentials before retrying.
All hosts sharing these checkpoints must use a version that understands the
optional `execution_windows[].retry_failed` marker.

### Assignment progress

Pass `onProgress` to `executeAgenticRun`, or `agentic.onProgress` to `runProject`.
The callback receives an `AgenticRunProgress` value on opening a saved run and
after each verified checkpoint:

```typescript
await executeAgenticRun(host, context, {
  projectDirectory,
  run: { id: savedRunId, mode: 'resume' },
  onProgress: (progress) => renderProgress(progress),
});
```

`total`, `accepted`, `running`, `pending`, and `failed` count assignments, not
output rows or pipeline tasks. Each assignment belongs to one count. Accepted
includes valid empty answers. A retryable failed attempt remains pending while
attempts remain. A terminal failure counts as failed until an explicit restart
allows another attempt. An interrupted attempt from an older execution window
counts as pending when resumed.

`steps` gives the same counts for each authored step. `totalIsFinal` is false
until all steps have fixed their work. A later reduce step can add assignments,
so a host must not show an overall percentage before this flag becomes true.
`status` and `publication` keep saved answers separate from confirmed warehouse
publication. An accepted answer is not proof that its output was published.

The values include only counts and run, model, and step identifiers. They contain
no input rows, answers, or provider errors. The callback gets a separate value and
cannot modify saved state. Keep it brief: Dogsled awaits it before continuing.
Callback errors do not fail a run or repeat model calls. Delivery is best effort,
not a durable event subscription. Reopening a run reports its current counts;
hosts can use the run ID, model name, and revision to ignore repeated reports.

The default is three attempts per assignment, including interrupted attempts.
The host can set one through ten attempts. All retries count toward the run's
spend caps and the assignment attempt limit. An explicit retry gets a fresh
execution deadline. Assignment retries and automatic lease recovery within that
invocation share its deadline; they cannot extend it. Each invocation records the
caps it applied, so a resume can raise them.

Checkpoints retain the original `started_at`, `deadline_at`, assignment templates,
and input retrieval times. The optional `execution_windows` history records each
explicit retry and its deadline. Live executor calls and the returned `deadlineAt`
use the current window. Accepted results remain bound to the window in which their
assignment attempt started. A new window cannot make an old late result acceptable.
Completed runs are reused; confirmed publication is not repeated.

The updated runner can read older checkpoints without retry windows. Once a retry
window is saved, use the updated runner to resume it. Supplied stores must use the
current `applyAgenticCheckpoint` transition, including `begin_execution`.

An empty result is still accepted work. `processedKeys` records its keys even when
`rows` is empty. An empty prepared input seals an empty work set and completes.

## Starting fresh after a failed incremental run

Use a new run ID with `mode: 'start'` to replace an unfinished incremental batch.
Omitting `agentic.run` from `runProject` creates that new ID automatically. Using
the same ID resumes the saved work and keeps its original token allowance.

A fresh start keeps the last committed input cursor. It reads the inputs again and
processes records after that cursor. Unpublished results from the old batch are not
reused. The old checkpoint and its token charges stay recorded; the new run has its
own allowance. Starting fresh can therefore incur additional AI costs.

Dogsled first acquires exclusive ownership of the old checkpoint. A live owner blocks
takeover. Dogsled then saves a permanent `superseded` marker before changing cursor
ownership with a compare-and-swap. A superseded run cannot resume or publish. If the
process stops between these writes, another fresh start can finish the takeover.
No checkpoint or cursor is deleted, and committed progress is not reset.

If the old run has prepared or confirmed publication, its warehouse write may already
have succeeded. Dogsled reports that the old run must be resumed to finish publication
and cursor recovery. A fresh start does not skip this check.

Local, DuckDB, and warehouse cursor stores support takeover. Custom cursor stores
must throw the exported `AgenticCursorConflict` with the current run ID when `begin`
finds a different owner, and implement `supersede` as an atomic owner comparison and
replacement that preserves committed cursor values. The coordinator retires the old
checkpoint under its state-store session before calling this method. Stores without
this optional method continue to reject takeover. All coordinators sharing a store
must use the updated checkpoint schema and `applyAgenticCheckpoint` implementation
before fresh-start takeover is enabled.

## Where state is stored

Dogsled uses the first of these that applies:

1. A store supplied as `stateStore`, or `agentic.stateStore` for `runProject`.
2. `checkpoint_store` in `model-spec.yml`, which can name a warehouse or a DuckDB integration.
3. A DuckDB file for the run under `.dogsled/model-spec/agentic-state`, when `@duckdb/node-api`
   can be loaded. It is an optional peer dependency that the `dogsled` CLI installs.
4. The [file store](#local-files-ownership-and-retention).

Steps 3 and 4 are the default store, `createDefaultAgenticStateStore(projectDirectory)`. Library
hosts can pass `createLocalAgenticStateStore(projectDirectory)` as `stateStore` to keep using files.

A run stays in the store that created it, and the two local stores share one lock file per run,
so a run has one owner either way:

- Installing DuckDB moves nothing. Runs already in the file store resume from it, and new runs
  use DuckDB. Each key's incremental cursor is read from the file store once, when the new store
  first sees that key, so progress carries over. That move is one-way: an older release reads the
  old value and would process those rows again, so do not downgrade after that first run.
- Removing DuckDB stops runs and cursors saved in DuckDB files with `unavailable`
  (`duckdb_required`) rather than starting them again from older state. Install the package to
  resume them. A DuckDB file cannot be read without the driver. Other new runs use the file store.

## Mixed model runs

`runProject` accepts the same options in `agentic` alongside
`agentic.host` and `agentic.publisher`, or the test-only
`experimentalAgenticProbe`. If the run identity is omitted, Dogsled creates a fresh local run ID.
Hosts that need restart must set and retain an explicit ID.

A host that supplies regular `state` must also supply `agentic.stateStore` or
configure `checkpoint_store` in `model-spec.yml`.
Dogsled reports a configuration error if checkpoint support is missing. Regular
model state remains compatible and uses its existing shape.

The probe publication callback is still a test seam. Its success is not a durable
publication receipt. On probe resume of already completed execution, Dogsled reports
pending publication and blocks downstream models. It does not call the publisher
again. A host must resolve publication separately before it can use this as a
production pipeline.

## Supplied store contract

Pass `stateStore` to `executeAgenticRun`, or `agentic.stateStore` to `runProject`.
The store implements `acquire(key)` and returns an exclusive session with `read`,
`create`, `checkpoint` and `release` methods. These contracts and their runtime
schemas are exported from the agentic subpath.

The session is the ownership capability. Every method must reject obsolete
ownership. Distributed hosts must use a fenced lease or an equivalent database
transaction. The built-in warehouse stores implement this contract for the databases listed
below; custom stores must provide equivalent guarantees.

`create` inserts a new preparing record only. `checkpoint` must apply the exported
`applyAgenticCheckpoint` transition under the same transaction that saves it.
The transition validates expected revisions, stable operation IDs, reservations,
retry bounds and accepted results. Duplicate commands have one effect. Reusing
an operation ID with a different payload causes a conflict. Reads return `null`
only when the run does not exist. Storage failures must throw.

`applyAgenticCheckpoint` returns a deeply frozen snapshot that holds none of your objects.
Treat it as read-only. Keep that value, pass it to the next `applyAgenticCheckpoint` call,
and return it from `checkpoint`. A start or finish of an attempt then costs the same however
large the run is. A store that parses or copies its state stays correct and pays for that on
every checkpoint. See [Checkpoint cost](#checkpoint-cost).

Every saved record must be durable before the method resolves. After an uncertain
checkpoint response, Dogsled reads the saved receipt before it dispatches more work.
The host must retain snapshots and their contents for its declared recovery period.
The current API uses bounded whole snapshots rather than unbounded record lists.
A store that removes old runs sets `expiresRuns`, and must never remove one with a publication.
Takeover then replaces a reservation whose run is gone; otherwise it reports the run `missing`.
A store can declare `limits` with `maxRows`, `maxBatchBytes` and `maxCheckpointBytes`. Dogsled
bounds each input batch by them and tells the host through `maxRows` and `maxBytes`; the store
rejects a larger checkpoint. Without `limits`, a store gets 1,000 rows, 1 MiB per batch and
16 MiB per checkpoint. These values are also the most a store can declare, because the snapshot
schema enforces them. All input and outcome values also use the existing agentic contract bounds.

Use `AgenticStateError` with a safe code: `conflict`, `missing`, `corrupt`,
`unavailable`, `limit` or `expired`. Dogsled removes other storage error messages at
the host boundary. Do not put credentials or raw provider responses in errors.

A session that may still hold its lease when it reports `lease_lost` should set
`retryAfterMs` in the error detail. Dogsled waits that many milliseconds before it
acquires again, so the session's own lease does not refuse the recovery attempt.
Without it, recovery starts at once.

## Row layout

The DuckDB stores and the [warehouse row store](#warehouse-row-store) save a run as rows, so what a
checkpoint writes does not grow with the run. A session keeps the snapshot in memory while it owns
the run, applies each command
with `applyAgenticCheckpoint`'s transition, and writes only what changed. Opening a run rebuilds
the snapshot from its rows. Commands, snapshots and the store interfaces are unchanged.

| Table                       | One row per                  | Holds                                                             |
| --------------------------- | ---------------------------- | ----------------------------------------------------------------- |
| `__dogsled_agentic_runs`    | Run                          | Identity, revision, ownership, newest write, small fields as JSON |
| `__dogsled_agentic_rows`    | Assignment or attempt update | Immutable content; the definition and input batch are stored once |
| `__dogsled_agentic_cursors` | Cursor key                   | The cursor record and a version for compare-and-swap              |

Writes in `__dogsled_agentic_rows` form a chain: each names its `parent`, and its `write_id` is a
digest of its parent, revision, operation ID and content. The header's `head` names the newest
committed write. A read walks back from `head`, verifies each digest, and never fetches anything
else. A long value spans several rows of one write. Before it reads any content, a load checks how
much the run holds, and it stops with `stored_rows_exceeded` past that bound. A header value too
long for a snapshot reads as `corrupt`.

The digest detects damage, not forgery. It has no key, so anyone who can write the store can write
a chain that verifies. Treat write access to a state file, or to the schema that holds these
tables, as trusted: whoever has it decides what a run resumes from.

Setup confirms that all of them are base tables with exactly the columns the store creates, because
`CREATE TABLE IF NOT EXISTS` keeps whatever already has the name. On DuckDB it also refuses indexes,
keys and check constraints on those tables, and any stored function in the file, because a stored
macro can replace a built-in in every statement run on that file. On PostgreSQL it also refuses a
table that the store's own role does not own, or that has a trigger, rule, row-level security,
check constraint or domain-typed column, because each of these runs code with the privileges of
the role that writes, or decides what the store sees. Any of these reports `corrupt`
with the reason `state_table_replaced`. So give a DuckDB store a file of its own. The check does
not look at column collations, user types or objects unrelated to the store. DuckDB state files
also open with external access and extension loading off, so nothing stored in one can read other
files or reach the network.

A file held open for a session is checked when it opens, and a file opened for each operation is
checked at each open. This refuses what was planted in a file before it was opened. It is no
defence against someone who writes the file with the owner's rights while a run is using it, which
the trust statement above covers.

A command writes its rows, then commits them with one update of the header. That update is the
only commit. It matches the session's owner, unexpired lease, token and revision, and its result
must report one changed row. There is no multi-statement transaction. Starting and finishing a
model call are four statements together, however large the run is. Commands that change no rows,
such as `complete`, are only the header update.

A crash between the two statements leaves rows that no header names. The header still describes
the previous state, so the run resumes from there, and the unfinished model call is treated like
any other interrupted attempt. A retry can write different content for the same operation ID,
such as a `seal_work` after preparation runs again: its digest differs, so it is a separate write
and the old rows stay unreachable. A worker that lost its lease can still insert rows, but its
header update changes nothing. A new owner deletes unreachable rows the first time it loads the
run. A session never trusts its memory after an uncertain write: it reloads from the rows first.

No table relies on a unique key, which three of the warehouses this layout targets do not
enforce. The row layout supports DuckDB, PostgreSQL and Snowflake.

Rows expire: acquiring a run and each header write set `retain_until`, 30 days ahead by default,
from the store's clock. A later acquisition removes unowned runs past that time. It claims each
one under a short lease first, so a resume cannot race the delete, and it deletes by run ID, so it
touches nothing else. The claim also empties the header, so from then on the run reads as new, and
never as damaged. If the purge stops partway, the lease ends and a later acquisition finishes.

This covers failed runs too: a run without incremental sources that is resumed after that time
starts again and pays again. A run still owed recovery does not expire: one with a prepared
publication, one with confirmed publication and uncommitted cursors, or a sealed incremental batch
that is not finished. Superseding such a run releases it. A preparing run does expire, because it
has no inputs, work or spend. If it held a cursor reservation, a later start replaces that
reservation. Cursor rows never expire.

### Why the row limits stay

The row store could hold more than today's 1,000 rows, and time no longer stands in the way.
Validating the whole snapshot on every checkpoint used to make a run's total overhead grow with
the square of its size, and [checkpoint cost](#checkpoint-cost) no longer does. These are DuckDB
run files on the synthetic benchmark workload, so they exclude any model time. The 2,000 row is
above today's limit of 1,000, so it lifted the ceilings in a scratch change:

| Assignments | Statements per assignment | Before |  After | Whole run, before | Whole run, after |
| ----------: | ------------------------: | -----: | -----: | ----------------: | ---------------: |
|         100 |                      4.13 |  78 ms | 4.4 ms |             7.8 s |            0.4 s |
|       1,000 |                      4.02 | 445 ms | 4.0 ms |           7.4 min |            4.1 s |
|       2,000 |                      4.01 | 878 ms | 3.6 ms |            29 min |            7.1 s |

Statements stay flat and data grows in step with the run. The limits stay because nothing has been
proved above them: the store conformance suite runs at today's limits. Raising one is a separate
change, with a measurement on the row store at the new size. See the
[benchmark](checkpoint-transport-benchmark.md#row-layout) for the method.

### Local DuckDB files

Each run has its own file, `.dogsled/model-spec/agentic-state/run-<hash>.duckdb`, which stays open
for the session. DuckDB allows one writing process per file, and a run file has one owner, so runs
in different processes do not contend. Commits go to DuckDB's write-ahead log, and closing the file
merges it. Incremental cursors use `agentic-state/cursors.duckdb`, which is opened for each
operation. A process that finds it busy retries for up to 30 seconds.

Ownership uses the same lock file as the file store, not DuckDB's own file lock. A process loses
that lock without warning when it opens and closes the same file a second time, so do not open a
run file from a process that may own the run. As with the file store, a crashed run can resume at
once. The directory is private and run files use private permissions. Symlinks are rejected.

An acquisition checks up to eight old run files and removes those that have expired. It skips any
file with a live owner. An empty file left by a crash expires the same way. Keep
`.dogsled/model-spec` on a local disk, as for the file store.

### DuckDB checkpoint store

`checkpoint_store` can name a writable, file-backed DuckDB integration:

```yaml
checkpoint_store:
  integration: checkpoints_duckdb
  schema: agentic_checkpoints
  lease_seconds: 300 # Optional. Default: 120. Range: 10–600 whole seconds.
  retention_days: 30 # Optional. Default: 30. DuckDB only. Range: 1–3650.
```

The three tables live in that schema, shared by every run, and ownership is the fenced lease
described under [warehouse checkpoints](#warehouse-checkpoints). A worker that crashes holds its
run until the lease expires. Statements have the client deadline described there, and a run that
hits it stops with `lease_lost (statement_timeout)`; DuckDB has no server-side limit to set. The
file is opened for each operation and never held between them. It must not be a model's output
file, which fails validation: a host reads that file outside this store's guard, and overlapping
instances of one file in a process can drop its lock. A run compares the real paths after resolving
secrets, so a symlink or a secret that leads to that file fails too. A hard link is not detected,
and neither, on a case-insensitive file system, is another spelling of a name that does not exist
yet.

The file holds frozen inputs and results, so on a shared host put it in a directory that only its
owner can read. Dogsled also sets the file to mode `600` when it connects, just after DuckDB
creates the file and before anything is saved in it. A failure is ignored, as for a file owned by
another user or on a file system without modes. DuckDB creates its write-ahead log, `<file>.wal`,
with the default permissions, and Dogsled cannot change that first. The log exists while an
operation writes, and after a crash until the file next opens.

Existing runs are not moved, so finish them before adding this setting. The store takes over each
cursor on first use of its key, from the DuckDB target or the default store. A key that an
unfinished run still holds fails with `cursor_held_elsewhere`, and nothing is written: this store
cannot open that run to take it over. Remove the setting, finish the run, then add it again.

### Warehouse row store

A warehouse `checkpoint_store` keeps using the [warehouse store](#warehouse-checkpoints), which
rewrites the whole run as one document on every checkpoint. A library host opts a run into rows by
supplying this store:

```typescript
import { createWarehouseRowStore } from '@bobsled-inc/model-spec/agentic';

const stateStore = createWarehouseRowStore(integration, {
  schema: 'track_checkpoints',
  database: 'writable_database', // Optional. Snowflake only.
  leaseMs: 300_000, // Optional. Default: 120,000. Range: 10,000–600,000.
  retentionMs: 30 * 86_400_000, // Optional. Default: 30 days.
});
await runProject(projectDirectory, { agentic: { host, stateStore } });
```

`integration` is a PostgreSQL or Snowflake integration with its secrets resolved. The options also
take what `createWarehouseCheckpointStore` takes, such as `customRunners`, `tokenProvider` and
`signal`. A supplied store comes first in [the selection](#where-state-is-stored), so it also applies
to a project that configures `checkpoint_store`. Other engines are rejected.

The three tables live in the given schema, shared by every run, so the store creates no tables per
run. Ownership is the same fenced lease, and each statement has the same
[limits](#warehouse-checkpoints) as the warehouse store: it runs on a dedicated session through the
same statement limit and client deadline. The role needs table creation, `SELECT`, `INSERT`,
`UPDATE` and `DELETE` in the schema. It needs to create schemas only if the schema does not exist
yet, so a role scoped to one pre-created schema is enough. Rows hold the same data as the warehouse
store, so apply the same access policies.

Runs in progress stay in the store that started them. A host that opts in must not resume them from
this store, which would not find them. Each cursor key takes its value from `__dogsled_cursors` in
that schema when the row store first sees the key, and never reads it again once the value has
landed. A key that an unfinished run still holds there fails with `cursor_held_elsewhere` and writes
nothing: this store cannot open that run to take it over. Finish the run from the previous store
first. A damaged record stops the key rather than starting it again from the beginning. So does a
role that cannot read the old table on PostgreSQL. Snowflake reports a table the role cannot see
exactly as it reports one that does not exist, so **on Snowflake the role must hold `SELECT` on
`__DOGSLED_CURSORS` wherever the old store ran**. Without it, a key starts from empty.

A carried value goes in as a bound update after the key's first row, never inside it. That first row
has version -1 until the value lands. If a process stops in between, the next use of the key reads
the old value again, so an empty row can never pass for a key with no progress. Do not drop
`__dogsled_cursors` while any cursor row has version -1: that key would start from empty.

|                           | PostgreSQL                        | Snowflake                                                   |
| ------------------------- | --------------------------------- | ----------------------------------------------------------- |
| One row per key           | Primary key, `ON CONFLICT`        | One transaction behind the guard table                      |
| Rows changed by an update | `RETURNING`                       | The count the update returns                                |
| Store clock               | `clock_timestamp()`               | `SYSDATE()`, which the session time zone cannot move        |
| Concurrent header updates | Row locks, so runs do not contend | One at a time per table: 2.2 a second in one sample         |
| Header tables             | One                               | 8, picked by a hash of the run                              |
| Largest `INSERT` (`data`) | 4 Mi characters, 256 rows         | 256 Ki characters, 128 rows, under the 1 MB statement limit |

Snowflake standard tables enforce no keys, so the first row for a run or cursor key goes through a
single script. It updates the one row of `__DOGSLED_AGENTIC_GUARD`, which makes concurrent scripts
take turns, then counts the key's rows and inserts only if there are none. This happens once per
run and once per key. If the guard has lost its row, the script stops before it adds anything, and
the store reports `corrupt` with the reason `state_table_replaced`. A statement that Snowflake
refuses because too many others wait for the same table lock never ran, so the store repeats it,
for about 15 seconds at most.

Because updates of one table queue, Snowflake keeps run headers in a fixed set of tables,
`__DOGSLED_AGENTIC_RUNS_8_0` to `__DOGSLED_AGENTIC_RUNS_8_7`, and PostgreSQL and DuckDB keep the one
table. The dialect names the size, and the run's hash picks the table, so two runs in different
tables never wait for each other's header update. Setup and the base table check cover every table,
and one statement looks for expired runs in all of them, so no table depends on a run happening to
land in it.

To change the size in a later version, put the new size first in the dialect's `headerTables` and keep
the old sizes after it. A table's name holds its size, so sets cannot collide. Setup creates the new
tables and new runs go there. A run that started in an older set is found there when it is opened,
for one read per older set, and it stays there until it ends, so no run has to move. Retention
visits every listed set. Keep a size listed for as long as a run can be in it. A first header goes
through the guard like any first row, and that script also counts the run's table in every other
listed set, so two openers can never give one run a header in two sets, even when a purge removes
it between them. Hosts that share a schema must change version together, because an older version
does not know the new tables and would start a second copy of a run it cannot find.

Each statement is a write of its own, so state sessions turn `AUTOCOMMIT` on, whatever the account's
default is.

A host that opens Snowflake through its own runner factory must provide four things the built-in
runner does: the result row of an `UPDATE`, with its `number of rows updated` column, returned from
`query`; `EXECUTE IMMEDIATE` scripts through `run`; `bigint` values among bind parameters; and
`AUTOCOMMIT` on in the session. Without the first, every write fails as an uncertain one rather than
reading as a lost lease. Run the
[live suite](../tests/integration/warehouse/README.md#agentic-store-conformance) through that factory
before switching.

**On PostgreSQL, no less-trusted role may hold `CREATE` on the store's schema.** Such a role can
create the store's tables before the store does. Setup refuses them rather than run that role's
code, but the store then stops until someone removes them. Do not use the `public` schema on
PostgreSQL 14 or older, where every role can create in it by default.

The store passes its conformance suite on PostgreSQL 17 and on a real Snowflake account, including
concurrent first use of a key and concurrent takeover of a lease. On one Snowflake account, in one
sample with 16 runs at once, a header update stayed near its single-run median of about 0.6
seconds, and the shared rows table held a schema to about 130 model calls a minute across all its
runs. See the [benchmark](checkpoint-transport-benchmark.md#row-store-header-tables) for the
figures.

## Local files, ownership and retention

This section describes the file store. `.dogsled/model-spec/run-state.json` is its state entry
point and also holds regular model state. Its compatible `agentic`
extension maps hashed run keys to digest-named snapshot files in `.dogsled/model-spec`. Snapshots
contain the frozen definition, input, attempts, usage, results and completion.
Reads check the digest, schema and scoped identity. Missing or damaged files cause
an explicit error. Dogsled does not replace them with empty state.

Regular and agentic saves use a shared file lock and update the current state.
They preserve unrelated model entries and unknown compatible fields. Each save
synchronizes the replacement file, renames it, then synchronizes the directory.
Agentic ownership spans execution and publication confirmation. Dogsled checks it again
before protected state changes.

Local ownership supports one host with a persistent local file system. It does
not support network file systems or multiple hosts. Locks include the host and
process ID. Dogsled reclaims a lock only after that process no longer exists. A
live process, a reused live process ID or an unknown host is never reclaimed.
A crash during lock recovery fails closed: an operator must confirm that no
writer remains before removing the recovery lock. Do not remove a live lock.

State directory and artifact symlinks are rejected. Snapshot names cannot escape
`.dogsled/model-spec`. Files use private permissions. Local limits are 100 retained runs, 16 MiB
per file, 2,000 directory entries and a 256 MiB directory budget. The budget check
includes orphan files and space for the next write. Exceeding a limit stops before
execution or the next checkpoint.

There is no automatic expiry. Referenced snapshots remain until the host removes
that run. After a successful checkpoint, Dogsled removes the previous snapshot.
A crash can leave an unreferenced snapshot or temporary file. For cleanup, stop
all project writers, back up `.dogsled/model-spec`, retain every snapshot named by `run-state.json`,
and remove only unreferenced snapshot or temporary files. Do not delete active run
records or pending-publication records that the host still needs. Deleting a run
record or required artifact removes its ability to resume. Temporary containers
must mount the same persistent project directory to recover local runs.

## Warehouse checkpoints

Configure a warehouse checkpoint store in the project `model-spec.yml`:

```yaml
checkpoint_store:
  integration: analytics_warehouse
  schema: track_checkpoints
  database: writable_database # Optional. Snowflake only; defaults to the integration database.
  lease_seconds: 300 # Optional. Default: 120. Range: 10–600 whole seconds.
```

The integration supplies the database or catalog and authentication. For Snowflake,
`database` can explicitly select a different database using the same authenticated
connection. Other warehouse types reject this field. Omitting it preserves the
integration database. `database` and `schema` are separate identifiers; a dot in
`schema` remains part of that schema name and never selects another database.
The selected database/schema contains checkpoint control and payload tables and
the shared incremental cursor table. Existing checkpoints are not moved. A run
must resume against its original checkpoint target.

Publication staging tables and receipts still use the output target's catalog and
the configured checkpoint schema, so output changes and receipts commit atomically.
A checkpoint database override does not redirect output or publication metadata.
For BigQuery, set one
`connection.project_id` on the integration. Keep credentials in the existing
integration secret mechanism.

The CLI resolves this store automatically. Library callers can use the same
configuration or supply an `AgenticStateStore`. Dogsled still rejects supplied
regular state without a supplied or configured checkpoint store. An unknown
checkpoint integration is an error. An explicit warehouse configuration never
falls back to local files.

The warehouse store uses the SQL runners for PostgreSQL, Snowflake, BigQuery, and
Databricks. Databricks requires catalog-managed tables and catalog commits, as
publication does. ClickHouse is rejected. A DuckDB integration uses the
[row layout](#duckdb-checkpoint-store) instead. Plain CLI execution without this
setting uses the [default store](#where-state-is-stored).

Checkpoint data includes prepared input records, accepted results, and intermediate
results. Each run uses two tables named from a hash of its scope, model, and run ID.
A control table contains one ownership lease and the current snapshot reference.
A payload table contains bounded, base64-encoded JSON chunks. Base64 is an encoding,
not encryption. Apply warehouse access and encryption policies to both tables.

The store stages a new snapshot, then atomically changes the current reference
under exclusive ownership. It removes old payload chunks in the same transaction.
Every protected write checks the owner token and warehouse-clock lease expiry.
The default lease is two minutes. Set `checkpoint_store.lease_seconds` to an integer
from 10 to 600 to allow more time for warehouse queueing. The store attempts renewal
every one-third of the lease period. A longer lease also delays takeover after a
worker crashes. Library callers can set `leaseMs` from 10,000 to 600,000 on the store
factory. The lease setting does not change the model execution deadline.

Each checkpoint and cursor statement can run for at most half the lease: 60 seconds
with the default lease, and 5 to 300 seconds across the allowed range. There is no
separate setting. Raise `lease_seconds` to give a slow or queueing warehouse more time
per statement. Time spent queued counts, so a statement that used to wait longer than
the limit and then succeed now fails.

The warehouse enforces the limit on sessions that Dogsled opens only for checkpoints
and cursors. Model queries and publication keep the warehouse defaults.

| Warehouse  | Server-side setting            |
| ---------- | ------------------------------ |
| PostgreSQL | `statement_timeout`            |
| Snowflake  | `STATEMENT_TIMEOUT_IN_SECONDS` |
| BigQuery   | `jobTimeoutMs` on each job     |
| Databricks | `STATEMENT_TIMEOUT`            |

Dogsled also keeps its own deadline in case a driver ignores that setting or a
connection stops answering. It is the limit plus one twelfth of the lease, 70 seconds
by default. Closing a connection waits at most one twelfth of the lease.

A custom runner factory receives the limit as `statementTimeoutMs`. Apply it to the
session the factory opens. A factory that ignores it keeps the client deadline, but the
statement keeps running on the warehouse. A factory that shares one session between
runners must not apply it to that session.

Behind a transaction-mode PostgreSQL pooler, `SET statement_timeout` does not reliably
stay on the session. The client deadline still applies, but the setting can persist on
the pooled server connection and affect other clients of that pooler.

Opening a connection holds no lease, so it has its own limit of five minutes, or the
client deadline if that is longer. This gives a stopped warehouse time to start while
the session is set up. A connection that does not open stops the run with
`unavailable (connect_timeout)`; check the warehouse, then resume.

When either limit is reached, the session reports `lease_lost (statement_timeout)` and
sends no more statements on that connection. A hung heartbeat is reported before the
lease expires. The session keeps its lease, because the statement may still be running.
A statement that lands late cannot overwrite a newer owner: writes check the owner and
expiry, and cursor updates compare a token. The driver's error, if there was one, stays
available as the error's `cause` and is not printed.

Dogsled then recovers in the same process. It waits one full lease, because a renewal
that landed late can extend the lease, then acquires ownership and reloads the saved
state. It makes up to two such attempts, sharing the run's execution deadline. The
statement may have committed before the limit was reached; the reload finds it, so the
change applies once. If the attempts fail, the run stops with
`lease_lost (statement_timeout)` and a later resume continues it. With the default
lease, a warehouse that hangs on every attempt stops the run in about eight minutes.

Library hosts can resolve the logical catalog/schema with
`resolveWarehouseCheckpointTarget(integration, { database, schema })` from
`@bobsled-inc/dogsled/model-spec/agentic`; the runtime uses the same resolver for checkpoint
and cursor storage.

If the warehouse session loses ownership, Dogsled cancels active assignments and
closes that session. It can make up to two recovery attempts. Each attempt must
acquire exclusive ownership and reload the saved checkpoint before doing more work.
Dogsled reuses saved results and reconciles saved publication receipts. Work without
a saved result can run again; its previous attempt remains charged.
Automatic lease recovery does not reset the current execution deadline, spend,
or assignment attempt limit. A later explicit retry can open a new execution window.
If another worker owns the run, or the warehouse still cannot grant ownership,
Dogsled stops. It does not steal an active lease or report success for unfinished work.

Supplied stores can expose `AgenticStateSession.ownershipLost` to cancel active
calls and throw `AgenticStateError('lease_lost')` to request this bounded recovery.
Use `conflict` for conflicting state or another active owner; Dogsled does not retry
those errors automatically. Existing stores without the optional signal continue
to work.

Snapshots are limited to 16 MiB before encoding. The store stops if retained
payload data exceeds 64 MiB before a new write. Failed writes can leave orphan
chunks. Successful writes remove superseded chunks. Run tables do not expire
automatically. Stop all owners before operator cleanup, and keep runs needed for
resume or publication recovery.

The checkpoint schema needs schema/table creation, SELECT, INSERT, UPDATE, and
DELETE permissions. The built-in warehouse publisher also uses this schema name
for control, stage-manifest, receipt, staging-data, and processed-key tables.
Publication tables stay in the output database or catalog and use its integration,
so publication and its receipt can commit together. To keep checkpoints and
publication tables in one physical schema, configure the checkpoint integration
with the same database or catalog as the model output.
Final output still uses the model's configured destination.

Without a configured checkpoint store, warehouse publication keeps its existing
target-schema default. DuckDB keeps its separate `_dogsled_agentic_publication`
schema. Hosts that supply their own publisher control its storage location;
`createSqlAgenticPublisher` accepts `systemSchema` for built-in warehouse publishers.

Finish existing runs before upgrading or changing this schema. Start a fresh run
after the change. Existing publication tables are not moved or deleted. Keep old
receipts and stages until no run needs them for recovery. Configured schema changes
are included in the run identity and cannot silently redirect a resumed run.
Caller-supplied SQL runners must preserve transaction connection identity and must
not replay writes after an ambiguous transport failure.

Cloud support needs live verification for each configured integration. The
credentialed test is `tests/integration/warehouse/cloud-checkpoint-store.test.ts`.
Local PostgreSQL tests cover saved work, ownership takeover, and a lost commit
response. These tests do not replace live Snowflake, BigQuery, or Databricks proof.

## Checkpoint cost

Each model call saves two checkpoints, `start_attempt` and `finish_attempt`. With a store that
keeps and returns what `applyAgenticCheckpoint` gave it, their cost does not depend on how many
assignments the run has. A store that replies with a copy still grows with the run, as the last
column shows. Overhead per assignment, with an in-memory store and a model call that returns at
once:

| Assignments |   Before |  After | After, store replies with a copy |
| ----------: | -------: | -----: | -------------------------------: |
|         100 |    75 ms | 1.6 ms |                           5.4 ms |
|       1,000 |   730 ms | 1.3 ms |                            35 ms |
|       2,000 | 1,411 ms | 1.3 ms |                            70 ms |

The 2,000 row is above today's limit of 1,000, so it was measured with the limits raised in a
scratch change: see [Reproduce](#reproduce). A run that size would spend 2.6 seconds on this
instead of 47 minutes. A plan that maps then reduces went from 112 ms to 3.0 ms per assignment
at 100, and from 1,056 ms to 2.7 ms at 1,000.

`AgenticRunSnapshotSchema` reads a private copy of a snapshot, and that same copy is deeply
frozen and remembered as verified, so what is kept is exactly what was checked. It cannot
change, so it needs checking again only if the clock moves behind a time saved in it. A start
or finish of an attempt on a verified snapshot copies only the work item it changes, and shares
the rest with the state before it. Only that item is checked, by the same code the schema
uses. Running totals stand in for what the schema learns by reading everything: the size
limits, the attempt IDs, and whether any attempt was overcharged.

The coordinator still validates every store response. It works out the state the command must
produce and requires the response to be exactly that. Frozen objects shared with verified
state compare equal without being read, which is why a store that returns its
`applyAgenticCheckpoint` result is flat. A copy is read in full, so that cost still grows with
the run, although the store has already paid more than that to make the copy. A response that
differs anywhere stops the run as `corrupt`, as it always has. So does one that holds the right
values but is not plain JSON, which takes the complete check.

The row store does exactly this, so DuckDB run files are flat too: see
[why the row limits stay](#why-the-row-limits-stay). The file and warehouse stores are not. They
rewrite the run on every checkpoint, which grows with the run whatever the coordinator does, and
they gain little from this.

Only these two commands take this path. The others happen a fixed number of times per run and
take the complete check. So does anything the path cannot prove: it can only accept, so the
complete check decides every refusal and reports it in the same words. Reads, resumes and the
ownership checks around publication are unchanged. The verified record lives in one loaded
copy of this package. Across two bundled copies a store's result counts as a copy.

### Why a proved command is valid

A proof starts from a verified snapshot, so it needs to show only that the command broke
nothing. For each thing the schema establishes:

- **The shape of what was written.** The changed item's attempts and accepted answer pass the
  schema's own field rules, and the totals pass the same bounds.
- **The rules within a work item.** `workMatchesRun` and `attemptsAreConsistent` run on the
  changed item. The schema runs the same two functions on every item.
- **Everything outside the item.** A transition is given frozen objects for all of it, so a
  write would throw. The few fields at the top of the run are compared, and only `revision`,
  `charged`, `charged_microusd` and `work` may differ.
- **Totals.** `charged` and `charged_microusd` must move by exactly what the item's attempts
  moved. They matched every attempt before, so they still do.
- **Revisions.** The new revision is one above a state whose revisions are all lower, so it
  is unique, later than everything else, and matches the count of transitions.
- **Attempt IDs.** The new ID must not be held in this state. An index of every ID ever seen
  from one verified root answers that, and each hit is confirmed against the state itself.
- **Reservations.** Everything charged so far is `charged`, so a new attempt's reservation is
  checked against it, where the schema would rebuild that sum from the revision history.
- **Overcharges.** A flag records any overcharged attempt. It is set from the same predicate
  and kept across states.
- **Assignments derived from inputs and earlier steps.** These are the same objects as before.
  A step's assignments depend only on saved inputs and on accepted work from earlier steps,
  and accepted work refuses both commands, so no proved command can alter what they were
  built from.
- **The size limits.** Totals of values, text and JSON bytes are moved by the change to the
  item, measured by the same walk the schema uses. They stop at exactly the same size. Depth
  needs no total: an answer is at most 16 levels deep, and its place in a snapshot adds five.
- **Saved times.** A new time is checked against the clock as it is written, and the newest
  saved time is kept. If the clock moves behind it, the state stops counting as verified, and
  the complete check refuses it as it always has.

`tests/unit/agentic/checkpoint-verified.test.ts` runs seeded walks that compare the two paths
command by command, and `checkpoint-proof.test.ts` damages the transition to show that a proof
does not depend on it being correct.

### Reproduce

`tests/unit/agentic/checkpoint-growth.bench.test.ts` runs in the unit suite and fails if the
cost of a checkpoint grows between 100 assignments and the row cap. To print the table above:

```sh
CHECKPOINT_BENCHMARK=1 CHECKPOINT_BENCHMARK_SIZES=100,1000 \
  pnpm --filter @bobsled-inc/model-spec exec vitest run \
  tests/unit/agentic/checkpoint-growth.bench.test.ts
```

Set `CHECKPOINT_BENCHMARK_PROFILE` to a directory for a V8 CPU profile of each run. Above 1,000
assignments, run on a scratch change that raises `AGENTIC_MAX_ROWS` and `AGENTIC_MAX_BYTES` in
`rows.ts` and the limits in `checkpoint-json.ts`. These limits are unchanged; the 2,000 row
above was measured that way, on both sides. The workload keeps each assignment the same size at
every run size.

## Incremental input progress

Input cursors track successful batches across run IDs. They are separate from
per-run checkpoints. See [incremental agentic inputs](../README.md#incremental-agentic-inputs)
for the YAML contract, shared storage, and host preparation requirements. Resume failed work to reuse its saved results, or follow the
[fresh-start takeover rules](#starting-fresh-after-a-failed-incremental-run).
Prepared or confirmed publication must be reconciled before a new batch.

After confirmed warehouse publication, `runProject` returns the model completion
entry in `state.models` under `<integration>.<model>`, including `priorFqName`,
`targetSchema`, and `targetDatabase` when set. Hosts can use these fields to
register the saved table. Dry runs, failed publication, and experimental probes
do not create this entry. Agentic checkpoints and incremental cursors remain in
the agentic state store.

Spend caps and deadlines are optional. See [optional execution limits](agentic-contracts.md#optional-execution-limits).
