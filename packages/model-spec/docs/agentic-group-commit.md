# Group commit for the agentic row store

**Status: experimental, off by default.** This is a design, a measurement and a prototype. The
prototype is behind `groupCommit: true` on `createWarehouseRowStore`. Nothing changes for a host that
does not set it.

## Summary

Every model call saves two checkpoints. On the [row store](agentic-state.md#row-layout) each one is
a row insert and one fenced update of the run's header, so a call costs about four statements, one
after another. On Snowflake a statement takes about half a second, so a run cannot do more than
about 27 calls a minute however many calls it has in flight, and a schema's shared rows table held
the runs in it to about 130 a minute in one sample.

Group commit saves the starts and finishes that are waiting as one checkpoint: one insert and one
header update for all of them. Each command is applied exactly as it is alone, keeps its own
operation ID and expected revision, and is stored as the same row write. A model call is still made
only once its start is saved. No guarantee becomes weaker; the
[guarantees](#guarantees-one-by-one) section goes through them.

On the Snowflake emulator, with statement times fitted to one real sample (the fit reproduces that
sample's throughput at 1, 4, 8 and 16 runs), group commit gave:

| Runs | Calls in flight each |      Model call | Calls a minute, one at a time → grouped |
| ---: | -------------------: | --------------: | --------------------------------------: |
|    1 |                    3 | returns at once |                                 20 → 92 |
|    1 |                    3 |       2 seconds |                                 21 → 47 |
|    1 |                    8 | returns at once |                                21 → 179 |
|    4 |                    3 | returns at once |                                73 → 348 |
|   16 |                    3 | returns at once |                               128 → 596 |

A call costs about 0.9 statements instead of 4.3, and 0.5 with eight calls in flight, and a free
slot waits about one commit for its next call instead of every checkpoint ahead of it. **These are
predictions from a model fitted to one sample on one account, not measurements of Snowflake:** no
account was available here. On PostgreSQL 17, a real engine with fast statements, the statements
per call fell the same way and runs did 1.3 to 1.7 times as many calls. The prototype passes the
store conformance suite on the emulator, DuckDB and PostgreSQL, and runs move both ways between it
and v0.1.10.

## Why a run is bounded today

The coordinator saves one checkpoint at a time. A call's start must be saved before the call, and
its finish after it, and each save is an insert followed by a header update that must report one
changed row. With concurrency 3, three calls can be in flight, but their six checkpoints still go
through one queue. On Snowflake, with about 550 ms per statement, that queue drains about one call
every 2.2 seconds: about 27 calls a minute, the figure one host application saw with three calls in
flight. A free slot waits behind every checkpoint ahead of it, which is up to `2 × concurrency - 1`
of them.

Across runs the limits are per table. Updates of one table run one at a time, which is why headers
are spread over 8 tables. Inserts into the shared rows table levelled off near 4.5 a second with 16
runs, which held the schema to about 130 calls a minute: every call inserts twice.

## Design

### What is grouped

The scheduler builds a group from the state the run would have after it:

1. The finish of every call that has returned, oldest first.
2. Then the start of as many calls as there are free slots, in work order.

Then it saves the group, waits for the store to confirm it, and only then makes the calls whose
starts it holds. Whatever becomes due while a group is being saved waits for the next group. There
is no timer: a group is as large as what was waiting, so groups grow when the store is slow and
shrink to one or two commands when it is fast.

Finishes come first so that the starts are decided on the charges the finishes record, exactly as a
start that follows a saved finish is today. A start for a work item whose previous attempt failed in
the same group sees that failure.

Only `start_attempt` and `finish_attempt` are grouped. Every other command happens a fixed number of
times per run and is still saved alone.

### How a group is stored

Nothing about the tables changes. The store applies each command to the state the one before it
produced, with `applyAgenticCheckpoint`, exactly as it applies a single command. Each command becomes
the same immutable write it would be alone: its own `write_id`, its own `revision` and its own
`operation_id`, chained by `parent` to the write before it. The rows of all the writes go into as few
`INSERT` statements as the dialect's bounds allow, which is one unless the answers are large (128
rows and 256 Ki characters per statement on Snowflake). Then one header update commits them all. It
is fenced exactly as today, on the session's owner, unexpired lease, token and the revision before
the group, and it sets the revision after the group.

So a run saved in groups is stored exactly as a run saved one command at a time, except that some
header states never existed. A reader walks the chain from `head` as it always has, and the walk
does not care how many writes each header update committed. A version that knows nothing of groups
reads such a run and resumes it, and this version resumes runs that version wrote.

### Expected revisions and operation IDs

A group has no identity of its own, and nothing stored names it. Each command keeps the
`operation_id` it has alone, `start_attempt:<attempt>` or `finish_attempt:<attempt>`. The first
command's `expected_revision` is the run's revision, and each later command's is the revision the one
before it produces, so a group of `n` commands moves the revision from `r` to `r + n`, as `n` single
commands would. The revisions an attempt records, `start_revision` and `finish_revision`, are the
same as they would be one at a time, so `checkpointIsConsistent` and the snapshot schema need no
change.

A repeated command has no effect, by the same rules as today, so a repeated group has one effect,
and so does a group whose first commands were already saved. A command that the transition refuses
fails the whole group before anything is written.

### When the model is called

A call is made only after the store has confirmed the group that holds its start: the header update
reported one changed row, or, after an uncertain reply, a read of the saved state showed the whole
group. Nothing about this is weaker than today, and no window opens in which a call runs without a
saved start.

The longest a call waits for its start to be saved, from the moment a slot is free, is one group
already being saved plus its own group: two commits of one insert and one header update each, about
2.2 seconds at the statement times above, more if a statement queues behind other runs. Today a free
slot waits behind every checkpoint ahead of it, up to `2 × concurrency - 1` of them. The
[measurement](#measurement) reports both waits.

### A lost reply in the middle of a group

The header update is the only commit, and a group has exactly one, so a group is saved whole or not
at all. There is no state in which some of its commands are saved and others are not.

- **The reply to an insert is lost.** The rows may or may not be there. No header names them, so
  they are orphans either way. The coordinator reads the saved state, finds the group missing, and
  sends its commands again, one at a time.
- **The reply to the header update is lost.** The coordinator reads the saved state, as it does after
  any uncertain reply. If the update landed, the read shows the whole group, which is checked
  command by command like any reply. If it did not, the read shows the state before the group, and
  the commands go again one at a time. Their writes repeat the group's own when the content is the
  same, and a finish's time makes them differ otherwise; either way the rows that no header reaches
  stay inert.
- **The update lands after the read.** A statement can still be running on the server when its reply
  is lost. The single commands that follow are fenced on the same token as the group. Whichever lands
  first changes the token, so the other changes nothing: either the late group commits nothing, or
  the first single command finds the token changed and reports lost ownership, and the run recovers
  by reloading the saved state, which then holds the group.
- **A read shows anything else**, such as some of the group's commands but not all, the run stops as
  `corrupt`. The store broke its contract and nothing it says can be trusted.

None of a group's calls is made until its commit is confirmed, so a lost reply never leads to a call
without a saved start.

### A lost lease in the middle of a group

If the lease is gone, the header update matches no row and the session reports `lease_lost`, as it
does for a single command. None of the group is saved, and its rows are orphans. Calls already in
flight are cancelled, and recovery waits out the lease, takes ownership again and reloads the saved
state, as today. The group's starts were never sent to a model. Its finishes were not saved, so
those calls run again after recovery, and their first attempts keep the charge they started with:
the same rule as for any call whose finish was not saved. A stale owner cannot commit a group,
because the fence is the same.

### Refusals, and why a group may only accept

The scheduler works a group out by applying each command, in order, to the state the run would have
before it. It uses the same rules as one command at a time: the attempt limit, blocked failures, the
spend cap, the old reservation accounting, and every other check `start_attempt` and `finish_attempt`
make. If the transition refuses a command there, the group ends before it, and that command is sent
alone after the group, so the store decides it and the run reports it in the same words as today.

The store can still refuse a group the scheduler expected to pass, for example because its clock
passed the deadline in between. It then writes nothing, the coordinator finds the state unchanged,
and the commands go one at a time. The finishes come first, so they are saved, and the refused
command fails exactly as it would have. A group is an optimisation that may only accept: every
refusal is decided by the path that decides it today.

### Stopping

A finish that stops the run, such as a failure that cannot be retried or an assignment that has used
its attempts, still ends the run once it is saved. The scheduler knows this when it builds the group,
so a group with such a finish holds no starts. If such an answer arrives while a group is being saved,
the group's calls are not made, and the next group saves the answer and stops. After a terminal
failure is known, no new call starts, as today. A call that threw stops the run without a finish, as
today. On a stop, answers that already returned are still saved, for spend-cap runs, and a group that
failed puts the answers it did not save back so that this still happens.

### Spend caps, deadlines and attempts

These are checked per command, by the same code, on the state each command sees:

- **Spend caps** are checked before each start, on a state that includes every earlier finish's charge
  and every earlier start's estimate in the group. That is the information a start has today, or
  newer. In-flight calls are counted at their estimate in both. The overshoot is still bounded by the
  calls in flight.
- **The old reservation accounting** reserves each start against the charges before it, as today.
- **Deadlines** are checked by the transition on the store's clock, per command.
- **Attempt limits** count each start in the group.

### The dispatch interval

A host that sets `minDispatchIntervalMs` gets one start per group, and a start joins a group only once
the interval since the last call has passed. The interval therefore holds between calls exactly as it
does today. Finishes still go in groups.

### The fast validation path

`checkpoint-verified.ts` needs no new rule. A group is a sequence of starts and finishes, and each is
proved as it is alone: against the state the one before it produced, which is verified because that
command was proved. On the store's side, applying a group costs what its commands change.

The coordinator checks a reply to a group the way it checks a reply to one command: it works out the
state the commands must produce from its own verified state, using the time the reply gives each
finish, which must fall within the request, and requires the reply to be exactly that. The row store
replies with the frozen state its last command produced, which shares every untouched work item with
the coordinator's own, so the comparison reads only what the group changed. A reply that is a copy
takes the complete check, which is correct and costs what the run holds, as it does for one command.
The scheduler works a group out on the coordinator's verified state, which also costs what the group
changes. `checkpoint-growth.bench.test.ts` checks groups as well.

### Progress reports

`onProgress` is called once per saved group rather than once per command. Each report is a state that
was saved, with the same counts a fresh count gives, and moves only the assignments the group names.
A host sees fewer intermediate states: a call can start and finish between two reports. Progress is
best effort and was never a stream of every state.

### What a host can see

None of these is a weaker guarantee, but each is a change:

- Fewer progress reports, and the revision moves by more than one between them.
- Calls start in bursts, up to the concurrency, rather than one checkpoint apart. A run reaches its
  concurrency at once. A host whose provider needs spacing sets `minDispatchIntervalMs`.
- A crash right after a group is saved and before its calls are made leaves up to `concurrency`
  attempts that started and never ran. Each keeps its estimated charge and counts towards its attempt
  limit. A crash today leaves up to `concurrency` calls in flight, with the same charges, so the bound
  is the same.
- An uncertain reply to a group that turns out not to be saved sends the commands again, one at a
  time. For a single command the run stops as `corrupt` in that case, as before.

## Guarantees, one by one

| Guarantee                                                       | One command at a time      | Group commit                                   |
| --------------------------------------------------------------- | -------------------------- | ---------------------------------------------- |
| A call's start is saved before the call                         | Yes                        | Yes: calls wait for their group's commit       |
| A resumed run never makes a charged call without a record of it | Yes                        | Yes, from the row above                        |
| A finish records the result and the spend                       | Yes                        | Yes, as the same write                         |
| One commit per change, the fenced header update                 | Yes                        | Yes: one per group, fenced the same way        |
| A stale owner commits nothing                                   | Yes                        | Yes: same fence                                |
| Each command has one effect                                     | Yes                        | Yes: same operation IDs and expected revisions |
| Rows are immutable and content-addressed                        | Yes                        | Yes: same writes                               |
| Spend caps are checked before dispatch                          | Yes                        | Yes, on the state including the group so far   |
| No new call after a known terminal failure                      | Yes                        | Yes                                            |
| Answers not yet saved when a run crashes                        | Those waiting in the queue | Those waiting for the next group, saved sooner |
| Attempts left started and not run by a crash                    | Up to the concurrency      | Up to the concurrency                          |
| Runs of the previous release resume                             | Yes                        | Yes, both ways, checked against v0.1.10        |

Nothing in the table is weaker, so the design stands.

## Alternatives

- **Save the start after the call, or within a window.** A crash in the window would lose the record
  of a call that may have been charged, and a resume would make it again. This weakens the main
  guarantee, so it is rejected. Group commit gets the throughput without it.
- **Send the next checkpoint before the last is confirmed.** Each one is fenced on the revision the
  last produced, and updates of one header run one at a time on Snowflake anyway. This is a group
  with more round trips.
- **One statement per commit.** Snowflake can insert and update together only in a script, and the
  row store's first-row script took about 1.6 seconds, more than the two statements it would replace.
- **Different tables, such as a rows table per run.** This changes the layout, which older versions
  could not read, and does not remove the four statements per call.

## Measurement

No Snowflake account was available for this, so the measurement is on the Snowflake emulator with
Snowflake's timing put back in. **These are predictions from a model fitted to one sample, not
measurements of Snowflake.** The [benchmark](checkpoint-transport-benchmark.md#row-store-header-tables)
can repeat them on a real account with the same settings: see [reproduce](#reproduce).

### Method

`tests/support/slow-snowflake.ts` gives each statement the time it took in the one-account sample
behind the [header tables](checkpoint-transport-benchmark.md#row-store-header-tables): a header
update about 550 ms, a row insert about 530 ms, a read about 290 ms, a setup statement about 234 ms
and the first-row script about 1.6 seconds. It keeps the two queues that sample showed. Updates of
one table run one at a time, about 2.2 a second, so an update holds its table for about 450 ms of
its time. Inserts into one table commit one at a time at about 4.5 a second, so an insert holds the
table from other inserts for about 222 ms. The emulator already runs the store's real SQL with
Snowflake's rules: no enforced keys, a lock per table for updates, and results as rows of counts.

There are two versions of the timing. **Medians** gives every statement its median time. **With a
tail** multiplies the time outside the queues by a log-normal factor with a median of 1 whose
logarithm has a standard deviation of 1. That puts a header update's p95 at about twice its median,
559 against 1,057 ms, as in the sample. The tail was fitted to the single run, and the other sizes
then matched without further fitting. It is the better model, and the first table in each pair
below uses it.

Each run is the synthetic map workload of the benchmark, with 60 assignments. Model calls return at
once, which is the worst case for the store, or after 2 seconds. Every run is a real run: the
coordinator, the scheduler, the store and its SQL are the shipped code, and only the warehouse is
emulated. Runs that share a schema run in one process against one emulator. A row is one sample, or
the median of two.

What the columns mean:

- **Calls a minute** counts model calls in all the runs together, from the first run's start to
  the last run's end, so it includes opening, sealing and completing each run.
- **Statements per call** counts every statement a run sends, divided by its calls, so it includes
  the fixed statements of a run: about 16 for 60 calls. Grouped, a call adds about two statements
  divided by the calls in its group.
- **Free slot waits** is how long a slot stays empty between one call returning and the next call
  starting in it: the finish of one, the start of the next, and every checkpoint queued ahead of
  them.
- **Longest start wait** is the longest any call waited from the moment its start was sent to the
  store to the moment the model was called.

### Calibration

Without groups, one call in flight per run and 30 assignments, as the sample was taken:

| Runs | Real account, calls a minute | Model, medians | Model, with a tail | Rows table inserts a second, tail |
| ---: | ---------------------------: | -------------: | -----------------: | --------------------------------: |
|    1 |                 17.7 to 20.4 |           24.8 |               17.4 |                              0.60 |
|    4 |                 67.5 to 80.2 |           97.2 |               71.2 |                              2.45 |
|    8 |               111.9 to 127.9 |          121.1 |              114.6 |                              3.95 |
|   16 |               125.3 to 133.0 |          125.3 |              125.1 |                              4.31 |

With medians alone the model is optimistic until the tables saturate, because a real statement
sometimes takes much longer than its median. With the tail it stays within the sample's range.

### One run

With a tail:

| Calls in flight | Model call | Calls a minute, off → on | Statements per call, off → on | Free slot waits, p50 off → on | Longest start wait, on |
| --------------: | ---------: | -----------------------: | ----------------------------: | ----------------------------: | ---------------------: |
|               3 |       0 ms |              19.7 → 92.1 |                   4.28 → 0.92 |                 8.3 s → 1.2 s |                  3.7 s |
|               3 |   2,000 ms |              21.0 → 46.6 |                   4.28 → 1.27 |                 5.8 s → 1.1 s |                  2.9 s |
|               8 |       0 ms |             21.3 → 179.2 |                   4.28 → 0.52 |                21.3 s → 1.2 s |                  2.9 s |
|               8 |   2,000 ms |              20.1 → 91.1 |                   4.28 → 0.62 |                19.1 s → 1.4 s |                  3.2 s |

With medians:

| Calls in flight | Model call | Calls a minute, off → on | Statements per call, off → on | Free slot waits, p50 off → on | Longest start wait, on |
| --------------: | ---------: | -----------------------: | ----------------------------: | ----------------------------: | ---------------------: |
|               3 |       0 ms |             25.8 → 119.3 |                   4.27 → 0.92 |                 6.5 s → 1.1 s |                  1.1 s |
|               3 |   2,000 ms |              25.6 → 50.6 |                   4.27 → 1.05 |                 4.0 s → 1.1 s |                  1.5 s |
|               8 |       0 ms |             25.8 → 210.3 |                   4.27 → 0.52 |                17.4 s → 1.1 s |                  1.1 s |
|               8 |   2,000 ms |             25.6 → 108.8 |                   4.27 → 0.52 |                15.4 s → 1.1 s |                  1.1 s |

Grouped, the statements per call fall from about 4.3 to about 0.9 with three calls in flight and
about 0.5 with eight, and a run is no longer held to 27 calls a minute. With three calls in flight
and calls that return at once it does about 4.7 times as many calls a minute, and with eight about 8
times, because each group carries a finish and a start for every slot. With 2-second calls, a run
spends most of its time waiting for the model, as it should: three slots that each wait a commit
between calls can do at most about 58 calls a minute, and the run did 47 to 51.

The longest any call waited for its start to be saved was about one group's commit, 1.1 seconds,
with medians, and under 4 seconds with the tail. A free slot used to wait for every checkpoint ahead
of it, a median of 17 to 21 seconds with eight calls in flight, and now waits about one commit.

### Runs that share a schema

Three calls in flight each, with a tail:

| Runs | Model call | Calls a minute, off → on |     Per run | Statements per call, off → on | Row inserts a second, off → on | Free slot waits, p50 off → on |
| ---: | ---------: | -----------------------: | ----------: | ----------------------------: | -----------------------------: | ----------------------------: |
|    4 |       0 ms |             73.4 → 348.2 | 18.4 → 87.0 |                   4.28 → 0.92 |                    2.51 → 2.32 |                 8.5 s → 1.2 s |
|    4 |   2,000 ms |             75.7 → 161.8 | 18.9 → 40.5 |                   4.28 → 1.12 |                    2.59 → 1.33 |                 6.2 s → 1.2 s |
|   16 |       0 ms |            127.8 → 595.9 |  8.0 → 37.2 |                   4.39 → 0.95 |                    4.37 → 3.97 |                21.1 s → 3.5 s |
|   16 |   2,000 ms |            127.4 → 459.3 |  8.0 → 28.7 |                   4.39 → 1.21 |                    4.35 → 4.06 |                19.2 s → 2.6 s |

With medians:

| Runs | Model call | Calls a minute, off → on |      Per run | Statements per call, off → on | Row inserts a second, off → on | Free slot waits, p50 off → on |
| ---: | ---------: | -----------------------: | -----------: | ----------------------------: | -----------------------------: | ----------------------------: |
|    4 |       0 ms |            101.9 → 452.5 | 25.5 → 113.1 |                   4.27 → 0.92 |                    3.48 → 3.02 |                 6.5 s → 1.1 s |
|    4 |   2,000 ms |            101.3 → 199.8 |  25.3 → 50.0 |                   4.27 → 0.93 |                    3.46 → 1.33 |                 4.0 s → 1.1 s |
|   16 |       0 ms |            128.4 → 603.7 |   8.0 → 37.7 |                   4.38 → 0.95 |                    4.39 → 4.02 |                21.5 s → 3.6 s |
|   16 |   2,000 ms |            128.4 → 433.1 |   8.0 → 27.1 |                   4.38 → 1.30 |                    4.39 → 4.14 |                19.5 s → 3.1 s |

With 16 runs the rows table is still the limit, at about 4 inserts a second either way. Grouped, each
insert carries about two and a half calls rather than half of one when calls return at once, so the
schema does about 4.7 times as many calls a minute. With 2-second calls fewer calls are waiting at
each commit, groups are smaller, and the gain is about 3.5 times.

### What the rows table's limit counts

The model holds the rows table once per `INSERT` statement, whatever the statement holds, and the
gain for runs that share a schema rests on that: a group puts more rows in each statement. The
sample supports it. Its inserts mostly held one row, but not all: a run of 30 assignments inserts
91 rows in 62 statements, because sealing its work inserts 30 rows at once. With 16 runs the sample
put about 16 × 62 statements and 16 × 91 rows into the rows table in 220 to 230 seconds: about 4.4
statements a second, the ceiling it reported, and about 6.5 rows. A limit of 4.5 rows a second could
not have let those rows in, so the limit counts statements, or something that grows with them, such
as commits. A run on a real account confirms it: the benchmark reports row inserts a second.

### What this does not show

- **Snowflake itself.** Everything here is the emulator with fitted timing. The first measurement on
  a real account should run this benchmark, and the conformance suite with
  `DOGSLED_MODEL_SPEC_GROUP_COMMIT=1`.
- **Large answers.** The workload's answers are small, so a group fits one insert. A group of large
  answers takes one insert per 256 Ki characters of them on Snowflake, which lengthens its commit
  but still sends fewer statements than one command at a time.
- **Real model calls**, whose times vary. Group sizes adapt to whatever returns while a commit runs.

### PostgreSQL

The same benchmark on PostgreSQL 17 in Docker: the real engine, 100 assignments per run, calls that
return at once, one process per run and one sample, on one laptop while other jobs ran. No run
failed.

| Runs × calls in flight | Calls a minute, off → on | Statements per call, off → on | Header update p50, off → on |
| ---------------------- | -----------------------: | ----------------------------: | --------------------------: |
| 1 × 3                  |          10,033 → 15,504 |                   4.11 → 0.81 |                0.6 → 1.0 ms |
| 1 × 8                  |           9,804 → 16,854 |                   4.11 → 0.39 |                0.7 → 1.4 ms |
| 4 × 3                  |          37,209 → 53,691 |                   4.11 → 0.81 |                0.6 → 0.8 ms |
| 4 × 8                  |          38,710 → 61,224 |                   4.11 → 0.39 |                0.6 → 1.1 ms |
| 16 × 3                 |          56,437 → 74,476 |                   4.11 → 0.81 |                2.0 → 4.8 ms |
| 16 × 8                 |          58,932 → 98,969 |                   4.11 → 0.39 |                1.9 → 5.2 ms |

PostgreSQL's statements take about a millisecond and it locks rows, so a run there was never held
to a few dozen calls a minute, and grouping gains less: 1.3 to 1.7 times as many calls. The
statements per call fall exactly as they do on the emulator, and the conformance suite passes on
this engine with groups.

### Reproduce

From `packages/model-spec`, the tables above come from:

```sh
CHECKPOINT_BENCHMARK=1 CHECKPOINT_BENCHMARK_EMULATOR=1 CHECKPOINT_BENCHMARK_LATENCY_TAIL=1 \
  CHECKPOINT_BENCHMARK_RUNS=1 CHECKPOINT_BENCHMARK_CONCURRENCY=3,8 \
  CHECKPOINT_BENCHMARK_MODEL_MS=0,2000 CHECKPOINT_BENCHMARK_GROUP_COMMIT=off,on \
  CHECKPOINT_BENCHMARK_ASSIGNMENTS=60 CHECKPOINT_BENCHMARK_SAMPLES=2 \
  pnpm exec vitest run tests/integration/warehouse/row-store-contention.bench.test.ts
```

Set `CHECKPOINT_BENCHMARK_RUNS=4,16` and `CHECKPOINT_BENCHMARK_CONCURRENCY=3` for runs that share
a schema, `CHECKPOINT_BENCHMARK_LATENCY_TAIL=0` for medians, and `CHECKPOINT_BENCHMARK_CONCURRENCY=1` with
30 assignments for the calibration. On a real account, leave out `CHECKPOINT_BENCHMARK_EMULATOR` and set
`DOGSLED_MODEL_SPEC_CHECKPOINT_INTEGRATION` and `DOGSLED_MODEL_SPEC_CHECKPOINT_SCHEMA` as for the
[live suite](../tests/integration/warehouse/README.md#agentic-store-conformance). Each run then has a
process of its own. On Snowflake, 30 assignments per run and one sample keep it under an hour.

## Prototype

- `createWarehouseRowStore(integration, { schema, groupCommit: true })` turns it on. The option is
  experimental and off by default. The DuckDB stores do not offer it.
- `AgenticStateSession.checkpointMany(commands)` is new and optional. A supplied store may implement
  it: it applies the commands in order with `applyAgenticCheckpoint` and saves all of them or none.
  Coordinators use it when it is there and send one command at a time when it is not.
- The coordinator in `run.ts` saves groups and checks their replies with `validateAgenticReceipts`.
  The scheduler in `schedule.ts` builds them; one command at a time is unchanged.
- The store conformance suite runs on the Snowflake emulator and on DuckDB with groups, including a
  group refused whole, a repeated group, a lost reply, and a group from an expired owner. Statement
  level tests cover a crash after a group's rows, a lost reply to either statement, and a run saved in
  groups read by a session that does not group. Unit tests compare runs saved in groups with runs
  saved one command at a time.

## Recommendation

The design holds: nothing it changes weakens a guarantee, and on the fitted model it removes the
bound of about 27 calls a minute on a run and lifts a shared schema about 4.7 times. Next, in order:

1. Merge the prototype as it is, experimental and off by default, once the change that raises the
   row caps has landed and this is rebased on it, with the suites and part of this measurement run
   again.
2. Before any host turns it on, run the live suite with `DOGSLED_MODEL_SPEC_GROUP_COMMIT=1` and this
   benchmark on a real Snowflake account, with 30 assignments and one sample. That checks the two
   things the emulator cannot: that Snowflake behaves as the dialect assumes when writes come in
   groups, and how the rows table's limit responds to inserts that carry several rows.
3. Then let one host try it with real model calls. With calls that take seconds, expect about twice
   the calls a minute at three in flight rather than 4.7 times: the store stops being the limit and
   the model's time decides.
4. Make it the default for the warehouse row store only after that, in a change of its own.

With many runs in one schema the rows table is still the limit, at about 4 inserts a second, but
each insert then carries several calls. Giving different models different schemas still divides it.
