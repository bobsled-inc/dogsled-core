#!/usr/bin/env bash

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEMO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
BASE_EXAMPLE_DIR="$(cd -- "$DEMO_DIR/../customer-resolution" && pwd)"
WORKDIR_ROOT="$DEMO_DIR/.runtime"
WORKDIR="$WORKDIR_ROOT/customer-resolution"
REPO_ROOT="$(cd -- "$DEMO_DIR/../../../../.." && pwd)"
CLI_BIN="$REPO_ROOT/packages/dogsled/dist/index.js"
export RUNNER_PATH="./runner.duckdb.js"
ARTIFACT_DIR="$WORKDIR/review/artifacts"

require_prereqs() {
  if ! command -v node >/dev/null 2>&1; then
    echo "node is required but was not found on PATH." >&2
    exit 1
  fi

  if ! command -v pnpm >/dev/null 2>&1; then
    echo "pnpm is required but was not found on PATH." >&2
    exit 1
  fi

  local node_major
  node_major="$(node -p "process.versions.node.split('.')[0]")"
  if [[ "$node_major" -lt 24 ]]; then
    echo "Node.js 24 or newer is required. Found $(node -v)." >&2
    exit 1
  fi
}

install_latest_cli() {
  local skip_install="${1:-0}"

  if [[ "$skip_install" != "1" ]]; then
    echo "Installing workspace dependencies..." >&2
    pnpm --dir "$REPO_ROOT" install >/dev/null
  fi

  echo "Building the latest dogsled CLI from the current checkout..." >&2
  pnpm --dir "$REPO_ROOT/packages/dogsled" build >/dev/null

  if [[ ! -f "$CLI_BIN" ]]; then
    echo "Built CLI not found at $CLI_BIN." >&2
    exit 1
  fi

  if ! (cd "$REPO_ROOT/packages/dogsled" && node -e "import('@duckdb/node-api')" >/dev/null 2>&1); then
    echo "Preparing workspace dependencies and native bindings..." >&2
    pnpm --dir "$REPO_ROOT" run setup >/dev/null
  fi

  echo "Using dogsled CLI version $(node "$CLI_BIN" --version)" >&2
}

reset_workdir() {
  if [[ -z "$WORKDIR" || -z "$WORKDIR_ROOT" || "$WORKDIR" == "/" || "$WORKDIR" != "$WORKDIR_ROOT"/* ]]; then
    echo "WORKDIR is invalid: '$WORKDIR'" >&2
    exit 1
  fi
  if [[ ! -d "$BASE_EXAMPLE_DIR" || ! -f "$BASE_EXAMPLE_DIR/model-spec.yml" ]]; then
    echo "Base example directory is invalid: '$BASE_EXAMPLE_DIR'" >&2
    exit 1
  fi

  rm -rf -- "$WORKDIR"
  mkdir -p "$WORKDIR_ROOT"
  cp -R "$BASE_EXAMPLE_DIR" "$WORKDIR"
  rm -rf -- "$WORKDIR/review"
  rm -f -- "$WORKDIR/customer_resolution.db"
  mkdir -p "$ARTIFACT_DIR"
}

run_model_json() {
  local output_path="$1"
  shift
  (
    cd "$WORKDIR" || exit 1
    node "$CLI_BIN" model "$@" --json --quiet >"$output_path"
  )
}

run_model_stdout() {
  (
    cd "$WORKDIR" || exit 1
    node "$CLI_BIN" model "$@"
  )
}

write_agent_csv_from_review_json() {
  local input_json="$1"
  local output_csv="$2"

  node --input-type=module - "$input_json" "$output_csv" <<'EOF'
import { readFileSync, writeFileSync } from 'node:fs';

const [inputPath, outputPath] = process.argv.slice(2);
const payload = JSON.parse(readFileSync(inputPath, 'utf8'));
const rows = payload.entities?.[0]?.rows ?? [];
const columns = [
  'pair_id',
  'record_a_id',
  'record_b_id',
  'source_a',
  'source_b',
  'composite_score',
  'threshold_band',
  'blocking_rules',
  'field_diffs',
  'recommended_action',
  'decision',
  'reviewer',
  'reason',
  'decided_at',
  'decision_source',
  'decision_batch_id',
  'applied_at',
];

function escapeCsv(value) {
  const stringValue = value == null ? '' : String(value);
  if (
    stringValue.includes('"') ||
    stringValue.includes(',') ||
    stringValue.includes('\n') ||
    stringValue.includes('\r')
  ) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

const lines = [
  columns.join(','),
  ...rows.map((row) =>
    columns.map((column) => escapeCsv(row[column] ?? '')).join(',')
  ),
];

writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
EOF
}
