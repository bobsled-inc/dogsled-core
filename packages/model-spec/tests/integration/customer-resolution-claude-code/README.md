# Customer Resolution Claude Code Demo

This demo wraps the base `customer-resolution` integration example with an explicit Claude Code handoff.

Use it when you want to show:

1. the pipeline exporting a bounded review queue as CSV
2. Claude Code acting as the agent that reads that CSV and writes decisions back
3. the pipeline importing those decisions and finishing cluster + survivorship + truthset checks

The base warehouse/model assets still live in `../customer-resolution`. This demo creates a clean working copy under `.runtime/customer-resolution` so the original example stays unchanged.

## Flow

Prepare the agent handoff:

```bash
cd packages/model-spec/tests/integration/customer-resolution-claude-code
bash scripts/prepare-claude-code-review.sh
```

That script:

- installs workspace deps
- builds the latest unified `bobsled` CLI from the current checkout
- creates a fresh `.runtime/customer-resolution` workdir
- loads seeds and runs resolution up to the review queue
- exports:
  - `review/customer_review_queue_full.csv` — the full pending review queue
  - `review/customer_review_queue.csv` — the bounded `review` queue for Claude Code
  - `review/customer_review_completed.csv` — the file Claude Code should edit
- writes `review/CLAUDE_CODE_REVIEW_TASK.md` with the exact task for Claude Code

After Claude Code edits `review/customer_review_completed.csv`, finish the run:

```bash
bash scripts/apply-claude-code-review.sh
```

That script:

- imports the completed CSV with `bobsled entity-graph review apply`
- runs clustering
- refreshes survivorship
- runs truthset regression
- reports the remaining `review` backlog

## Agent Role

Claude Code is the bounded agent in this demo.

- The exported CSV is the agent’s input contract.
- Claude Code acts on rows in the single `review` queue.
- Low-confidence agent decisions still round-trip through the normal review artifact instead of bypassing the pipeline.
- The agent’s output is a CSV decision file, which the OSS CLI then applies through the normal `review apply` path.

That makes the handoff concrete: the agent does not bypass the pipeline or mutate warehouse state directly. It reads exported evidence, writes a review artifact, and the pipeline applies that artifact.
