#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SKIP_INSTALL="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-install)
      SKIP_INSTALL="1"
      shift
      ;;
    --help|-h)
      cat <<'EOF'
Usage:
  bash scripts/prepare-claude-code-review.sh [--skip-install]
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

source "$SCRIPT_DIR/_common.sh"

require_prereqs
install_latest_cli "$SKIP_INSTALL"
reset_workdir

run_model_json "$ARTIFACT_DIR/01-seed-load.json" seed load --runner "$RUNNER_PATH" --dialect duckdb
run_model_json "$ARTIFACT_DIR/02-resolve-run.json" resolve run customer --runner "$RUNNER_PATH" --dialect duckdb
run_model_json "$ARTIFACT_DIR/03-resolve-status.json" resolve status customer --runner "$RUNNER_PATH" --dialect duckdb
run_model_json "$ARTIFACT_DIR/04-agent-triage.json" agent triage customer --runner "$RUNNER_PATH" --dialect duckdb

run_model_stdout review export customer \
  --runner "$RUNNER_PATH" \
  --dialect duckdb \
  --format csv \
  --output review/customer_review_queue_full.csv \
  --template >/dev/null

run_model_json \
  "$ARTIFACT_DIR/05-agent-review-list.json" \
  review list customer \
  --runner "$RUNNER_PATH" \
  --dialect duckdb \
  --threshold-band review

write_agent_csv_from_review_json \
  "$ARTIFACT_DIR/05-agent-review-list.json" \
  "$WORKDIR/review/customer_review_queue.csv"

cp \
  "$WORKDIR/review/customer_review_queue.csv" \
  "$WORKDIR/review/customer_review_completed.csv"

AGENT_ROWS="$(node --input-type=module - "$ARTIFACT_DIR/05-agent-review-list.json" <<'EOF'
import { readFileSync } from 'node:fs';
const payload = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const rowCount = payload.entities?.[0]?.row_count ?? 0;
console.log(String(rowCount));
EOF
)"

if [[ -z "$AGENT_ROWS" || "$AGENT_ROWS" == "0" ]]; then
  echo "No review rows were generated. The demo no longer exercises the Claude Code review path." >&2
  exit 1
fi

cat >"$WORKDIR/review/CLAUDE_CODE_REVIEW_TASK.md" <<EOF
# Claude Code Review Task

You are reviewing exported Entity Graph candidate pairs for the Bobsled Core customer-resolution demo.

## Files

- Working directory: \`$WORKDIR\`
- Read-only full queue: \`$WORKDIR/review/customer_review_queue_full.csv\`
- Bounded review queue: \`$WORKDIR/review/customer_review_queue.csv\`
- Edit this file in place: \`$WORKDIR/review/customer_review_completed.csv\`

## Task

1. Open \`customer_review_completed.csv\`.
2. Review each row and fill these columns:
   - \`decision\`: \`merge\`, \`not_match\`, or \`defer\`
   - \`reviewer\`: \`claude-code\`
   - \`reason\`: one short evidence-based explanation
3. Preserve the existing CSV header, all existing columns, and all row order.
4. Do not modify \`pair_id\` or any source identifiers.
5. Keep the file as CSV.

## Decision Policy

- Only use evidence in the row: \`composite_score\`, \`blocking_rules\`, \`field_diffs\`, and \`recommended_action\`.
- \`recommended_action\` is a hint, not a command.
- Use \`defer\` when the evidence is not strong enough for an autonomous decision.
- This file already contains only \`review\` rows from the single review queue.

## Finish

When the CSV is complete, tell the operator to run:

\`\`\`bash
cd "$DEMO_DIR"
bash scripts/apply-claude-code-review.sh
\`\`\`
EOF

cat <<EOF
Prepared the Claude Code review demo.

Workdir:
  $WORKDIR

Generated files:
  $WORKDIR/review/customer_review_queue_full.csv
  $WORKDIR/review/customer_review_queue.csv
  $WORKDIR/review/customer_review_completed.csv
  $WORKDIR/review/CLAUDE_CODE_REVIEW_TASK.md

Review rows ready for Claude Code:
  $AGENT_ROWS

Next:
  1. Open or paste:
     $WORKDIR/review/CLAUDE_CODE_REVIEW_TASK.md
  2. Have Claude Code edit:
     $WORKDIR/review/customer_review_completed.csv
  3. Then run:
     cd "$DEMO_DIR"
     bash scripts/apply-claude-code-review.sh
EOF
