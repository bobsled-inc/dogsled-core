# Agentic models with the test AI model

Run `pnpm e2e:agentic-mock`. This credential-free example runs 20 fictional
assignments through a deterministic executor, kills the process before assignment
11 returns, and resumes from its durable local checkpoint.
The first ten accepted results are reused. The final table has 20 distinct rows
with evidence, confidence and run identity; a second resume makes no more calls.

The executor uses Dogsled's public `ai/test-stubs` export:
`mockStructuredOk` and `AlwaysOkBudgetLedger`. It also uses the real persisted
assignment token budget and validates the real assignment/outcome contracts.
It makes no AI-provider request. The model profile uses a synthetic placeholder
only to exercise CLI wiring.

Copy this project into a new folder and install Dogsled locally. The first model
run deliberately exits after ten accepted results; the second resumes it:

```bash
dogsled query "CREATE TABLE pairs AS SELECT 'pair-' || lpad(CAST(i AS VARCHAR), 3, '0') AS pair_id, 'Fictional evidence only' AS evidence FROM range(1,21) AS t(i)" --db-path data.duckdb
export SHOWCASE_MODEL_KEY=synthetic-test-model-key
SHOWCASE_CRASH=1 dogsled model run +pair_assessments --integration local --agent-executor ./mock-executor.mjs --agent-run-id showcase-resume --agent-tokens-per-assignment 8192 --json
dogsled model run +pair_assessments --integration local --agent-executor ./mock-executor.mjs --agent-run-id showcase-resume --agent-tokens-per-assignment 8192 --agent-resume --json
dogsled query "SELECT COUNT(*) AS assignments FROM pair_assessments" --db-path data.duckdb
```

DuckDB runs use durable local checkpoint files; warehouse checkpoint tables are
reserved for the supported remote SQL stores. The DuckDB publication adapter keeps
its metadata in `_bobsled_agentic_publication`. The automated script injects the
crash and checks accepted-call counts, persisted rows, and both metadata stores.

The `@bobsled-inc/bobsled-core/ai/test-stubs` export is unstable and test-only. Use it
for deterministic examples and tests; it is not a supported production model API.
