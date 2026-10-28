#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
INPUT_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --input)
      if [[ $# -lt 2 || -z "${2:-}" || "${2:-}" == -* ]]; then
        echo "--input requires a path" >&2
        exit 2
      fi
      INPUT_PATH="${2:-}"
      shift 2
      ;;
    --help|-h)
      cat <<'EOF'
Usage:
  bash scripts/apply-claude-code-review.sh [--input <path>]

Defaults:
  --input .runtime/customer-resolution/review/customer_review_completed.csv
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

if [[ ! -d "$WORKDIR" ]]; then
  echo "Workdir not found at $WORKDIR. Run prepare-claude-code-review.sh first." >&2
  exit 1
fi

if [[ -z "$INPUT_PATH" ]]; then
  INPUT_PATH="$WORKDIR/review/customer_review_completed.csv"
elif [[ "$INPUT_PATH" != /* ]]; then
  INPUT_PATH="$(cd -- "$PWD" && pwd)/$INPUT_PATH"
fi

if [[ ! -f "$INPUT_PATH" ]]; then
  echo "Decision CSV not found: $INPUT_PATH" >&2
  exit 1
fi

mkdir -p "$ARTIFACT_DIR"

run_model_json \
  "$ARTIFACT_DIR/06-review-apply.json" \
  review apply \
  --input "$INPUT_PATH" \
  --entity customer \
  --decision-source claude-code \
  --runner "$RUNNER_PATH" \
  --dialect duckdb

run_model_json \
  "$ARTIFACT_DIR/07-resolve-cluster.json" \
  resolve cluster customer --runner "$RUNNER_PATH" --dialect duckdb
run_model_json \
  "$ARTIFACT_DIR/08-survivorship-refresh.json" \
  agent survivorship-refresh customer --runner "$RUNNER_PATH" --dialect duckdb
run_model_json \
  "$ARTIFACT_DIR/09-truthset-regress.json" \
  agent truthset-regress customer --runner "$RUNNER_PATH" --dialect duckdb
run_model_json \
  "$ARTIFACT_DIR/10-review-backlog.json" \
  review list customer --runner "$RUNNER_PATH" --dialect duckdb --threshold-band review

node --input-type=module - \
  "$ARTIFACT_DIR/06-review-apply.json" \
  "$ARTIFACT_DIR/09-truthset-regress.json" \
  "$ARTIFACT_DIR/10-review-backlog.json" <<'EOF'
import { readFileSync } from 'node:fs';

const [applyPath, truthsetPath, backlogPath] = process.argv.slice(2);
const applyJson = JSON.parse(readFileSync(applyPath, 'utf8'));
const truthsetJson = JSON.parse(readFileSync(truthsetPath, 'utf8'));
const backlogJson = JSON.parse(readFileSync(backlogPath, 'utf8'));

const appliedCount = applyJson.applied_count ?? applyJson.summary?.applied_count ?? 0;
if (appliedCount <= 0) {
  throw new Error('Expected review apply to write at least one Claude Code decision.');
}

const truthsetEntity = truthsetJson.summary?.entities?.[0];
if (!truthsetEntity) {
  throw new Error('Expected truthset summary to include at least one entity.');
}
if (truthsetEntity.required_precision == null) {
  throw new Error('Expected truthset required_precision to be present.');
}
if (truthsetEntity.current_metrics?.auto_merge_precision == null) {
  throw new Error('Expected truthset auto_merge_precision to be present.');
}
const requiredPrecision = Number(truthsetEntity.required_precision);
const precision = Number(truthsetEntity.current_metrics.auto_merge_precision);
if (!Number.isFinite(requiredPrecision)) {
  throw new Error(`Expected truthset required precision to be finite, received ${requiredPrecision}.`);
}
if (!Number.isFinite(precision) || precision < requiredPrecision) {
  throw new Error(
    `Expected truthset auto-merge precision >= ${requiredPrecision}, received ${precision}.`
  );
}

const backlogEntity = backlogJson.entities?.[0];
if (!backlogEntity || backlogEntity.row_count == null) {
  throw new Error('Expected review backlog output to include row_count.');
}
const backlogCount = Number(backlogEntity.row_count);
if (!Number.isFinite(backlogCount)) {
  throw new Error(`Expected review backlog row_count to be finite, received ${backlogCount}.`);
}

console.log(
  JSON.stringify(
    {
      status: 'ok',
      applied_count: appliedCount,
      auto_merge_precision: precision,
      required_precision: requiredPrecision,
      remaining_review_count: backlogCount,
    },
    null,
    2
  )
);
EOF
