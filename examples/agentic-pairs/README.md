# Assess synthetic pairs with an LLM

This is a small, separate Dogsled project. Its executor is local application code.
It uses Dogsled's public AI API to make one LLM call for each prepared pair.

```text
raw_pairs                 Four synthetic pairs in a local database
    |
    v
undecided_pairs           SQL keeps the three undecided pairs
    |
    v
pair_assessments          One direct LLM call for each pair
    |
    v
pair_decisions            SQL applies a fixed policy to the advice
```

The LLM can return `same_user`, `different_user`, or `insufficient_evidence`.
The final SQL model selects the next action. It sets `merge_authorized` to
`false` for every row. No component in this example merges records.

## Run the example

Use Node.js 24 or later and a Dogsled build that includes the agentic executor
options. Install a matching Dogsled tarball for the source revision you are testing.
Replace the path below with the path to that tarball. Run these commands from this
example directory. See the [user guide](../../docs/guides/agentic-models.md) for
authoring, the YAML reference, and operational guidance.

```bash
npm install /absolute/path/to/bobsled-inc-bobsled-VERSION.tgz
node seed.mjs
```

Set `OPENAI_API_KEY` in your shell through your normal secret manager. The
`review` profile in `dogsled.yml` reads that variable. Do not put a key in YAML.
The live run sends only the supplied synthetic records to the provider. It makes
three paid calls on a successful fresh run. Model output can differ between runs.

```bash
npx @bobsled-inc/bobsled-core model run +pair_decisions --integration local \
  --agent-executor ./executor.mjs \
  --agent-run-id proof-1 \
  --json
```

The `+` selector includes upstream models. Dogsled runs them before the final model. The model has
a 30,000-token cap and a 180-second timeout. When the run reaches the cap, Dogsled
stops starting new assignments, keeps the answers it already has, and prints how
to continue. Add `--agent-max-cost <usd>` for a dollar cap as well.

## Resume a failed run

Use the same run ID and add `--agent-resume`.

```bash
npx @bobsled-inc/bobsled-core model run +pair_decisions --integration local \
  --agent-executor ./executor.mjs \
  --agent-run-id proof-1 \
  --agent-resume --json
```

Dogsled uses saved input and accepted results to resume the agentic work. A call
that failed before its result was saved may run again. To start new work, use
a new run ID and omit `--agent-resume`.

Keep `.dogsled/model-spec/` to retain local run state and snapshots. Keep `data/pairs.duckdb`
to retain the source tables and published model tables. These serve different
purposes. Both survive a process restart while their files remain available.

## Inspect the result

Open `data/pairs.duckdb` with a DuckDB client and run:

```sql
SELECT pair_id, assessment, reason FROM main.pair_assessments ORDER BY pair_id;
SELECT * FROM main.pair_decisions ORDER BY pair_id;
```

Expect three output pairs. Pair 4 is already decided, so SQL excludes it before
the LLM runs. The prepared evidence supports one shared account, one conflict,
and one case with too little evidence. The final model requests review for a
shared account, keeps conflicting accounts separate, and asks for more evidence
for the remaining case.

The seed script replaces only `main.raw_pairs`. It does not clear run state or
published model tables. Use a new run ID after changing the input or model.
The example uses DuckDB so you can run the proof locally. Database publication
in Dogsled is not limited to DuckDB.

## Evidence dates

Dogsled records `input.retrieved_at` when the host returns the prepared input.
Dogsled saves that value with the assignment and preserves it on resume.
This time describes input preparation. It does not describe the age of the source records.

The provider output schema omits `retrieved_at`. The executor attaches the saved
host value after it validates the provider response. Dogsled rejects a different
evidence date for this input. If an older assignment has no saved date, this
executor cannot return non-null evidence for it. It does not invent a fallback date.

## Use the reference agent loop

`loop-executor.mjs` shows how to make several LLM calls in one assignment.
Use it with an `agent_loop` plan step and the host's scoped source adapter.
The direct-call model above still uses `executor.mjs`.

The loop asks the model for one structured decision at a time:

```text
Prepared pair + instructions + saved Skills
                    |
                    v
               LLM decision <----------+
               /    |     \            |
            read  search  finish       |
              \    /        |          |
         Scoped source     Validate    |
             callback      output      |
                |                      |
         Bounded source response ------+
```

A read decision has this shape:

```json
{
  "decision": {
    "action": "read",
    "source": "customers",
    "arguments": { "limit": 10, "columns": ["name"], "search": null }
  }
}
```

Use an actual permitted source ref for `source`. A search decision sets
`action` to `search`, `columns` to null, and `search` to the search text.
The host checks the operation against the source's published capabilities.
This small executor does not expose filters or every API query option.

Set `limits.model_calls_per_assignment` in YAML to cap decisions. The loop also
accepts an explicit `maxTurns` factory fallback; without either, it has no fixed
decision cap. Each response must pass a strict schema.
Only `read`, `search`, and `finish` are valid actions. The provider receives no
SDK tools. Source access goes through `request.sources`. The model cannot supply
SQL, a URL, a file path, or a shell command. Source text stays in the data history,
even when that text contains instructions.

Each LLM call reports its usage to Dogsled after it stops. The calls share one
assignment deadline. There are no hidden provider retries. Each call has a 1,024
output-token cap, and a loop stops after 16 turns. The executor rejects a prompt
and schema above its 32 KiB allowance. It rejects source responses above 64 KiB or
100 rows. It fails when a limit is reached. It does not publish a partial answer.
Provider errors, responses without usage, and invalid output permit a
whole-assignment retry under Dogsled's shared retry limit. Cancellation, source
denial, and exhausted limits do not permit a retry.

Resume reuses accepted assignments. It restarts an unfinished loop from its
prepared input; it does not resume at an internal decision. Reads and LLM calls
from that unfinished attempt can run again. An interrupted attempt stays charged
at its input estimate even when the process stops before it reports usage.

Evidence includes an `observation` number in the provider response. Zero means
prepared input. One means the first source response, and so on. The executor
removes this number and attaches the selected host retrieval time. The provider
cannot set that time. This also distinguishes two reads of the same source.

This module is trusted JavaScript run by the host. It is not an OS sandbox.
Review a replacement executor before loading it. The source callback and strict
decisions limit what this executor gives the model; they do not restrict what
arbitrary JavaScript can do.

Run `npm test` here for deterministic tests of both reference executors.
These tests use a fake provider and make no paid calls.

## Multi-step inputs

Both reference executors pass `assignment.inputs` to the provider when it is
present. Each named bundle keeps its own rows, columns, source ref, and completion
marker. An empty completed bundle means that the step succeeded with no rows.
It does not mean that the step failed or is still running.

A reduce step can read several named bundles and return one result for its group.
Evidence can cite any supplied bundle by its ref. The executor attaches that
bundle's saved retrieval time. For the loop executor, observation zero means a
prepared bundle; the evidence source selects which bundle. Source-read observation
numbers keep their existing meaning.

Use an earlier step ID for each reduce input. For example, after separate
`names` and `phones` map steps, the final step can use:

```yaml
- id: combine
  source: { ref: names }
  reduce:
    over: [names, phones]
    group_by: [pair_id]
  execution: { mode: llm_call }
  instructions: Compare both findings. Return advice based on their evidence.
  columns:
    - { name: pair_id, type: string, nullable: false }
    - { name: assessment, type: string, nullable: false }
    - { name: reason, type: string, nullable: false }
```

Set `output.from: combine` to publish this step. `source.ref` must equal the first
entry in `reduce.over`. A single string remains valid for one reduce input.
Each input must contain the same processed keys for a group. A missing group is
an error. An accepted empty result still carries its processed keys.

Dogsled runs steps in the order written. It runs assignments within each step up
to the configured concurrency. All steps share the run's token limit, deadline,
and call-start interval. Dogsled saves all external plan inputs before execution.
Intermediate findings stay in run state. Dogsled publishes the selected output
only after all steps succeed. Source tools can still read fresh data during an
agent loop; they are separate from these saved plan inputs.

Each step must return the grouping and replacement keys. Intermediate output
uses the model grain when those columns exist; otherwise it uses the grouping
and replacement keys together. A later group cannot depend on a new field from
an empty earlier result because there is no value to group by.

`combineAgenticEvidence()` is available from the public agentic API. It removes
exact duplicate observations and preserves original dates. It does not average
confidence or choose which finding is true. An executor can use it when it
combines evidence; Dogsled does not turn findings into automatic corrections.
