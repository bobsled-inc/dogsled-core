#!/usr/bin/env bash
set -euo pipefail

MODE="test"
DIALECT="duckdb"
SKIP_INSTALL="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      if [[ $# -lt 2 || -z "${2:-}" || "${2:-}" == --* ]]; then
        echo "--mode requires a value" >&2
        exit 2
      fi
      MODE="${2:-}"
      shift 2
      ;;
    --dialect)
      if [[ $# -lt 2 || -z "${2:-}" || "${2:-}" == --* ]]; then
        echo "--dialect requires a value" >&2
        exit 2
      fi
      DIALECT="${2:-}"
      shift 2
      ;;
    --skip-install)
      SKIP_INSTALL="1"
      shift
      ;;
    --help|-h)
      cat <<'EOF'
Usage:
  bash scripts/install-and-run-latest-cli.sh [--mode illustrative|test] [--dialect duckdb|bigquery] [--skip-install]

Defaults:
  --mode test
  --dialect duckdb
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ "$MODE" != "illustrative" && "$MODE" != "test" ]]; then
  echo "Invalid mode: $MODE" >&2
  exit 2
fi

if [[ "$DIALECT" != "duckdb" && "$DIALECT" != "bigquery" ]]; then
  echo "Invalid dialect: $DIALECT" >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required but was not found on PATH." >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required but was not found on PATH." >&2
  exit 1
fi

# Node 24+ keeps the CLI's ESM execution path stable across the built dist entrypoint.
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$NODE_MAJOR" -lt 24 ]]; then
  echo "Node.js 24 or newer is required. Found $(node -v)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd -- "$PROJECT_DIR/../../../../.." && pwd)"
CLI_BIN="$REPO_ROOT/packages/bobsled-core/dist/index.js"
RUNNER="$PROJECT_DIR/runner.${DIALECT}.js"

if [[ "$DIALECT" == "bigquery" && ! -f "$PROJECT_DIR/runner.config.json" ]]; then
  echo "BigQuery requires runner.config.json. Copy runner.config.json.example and fill in credentials." >&2
  exit 1
fi

if [[ "$SKIP_INSTALL" != "1" ]]; then
  echo "Installing workspace dependencies..." >&2
  pnpm --dir "$REPO_ROOT" install >/dev/null
fi

echo "Building the latest bobsled CLI from the current checkout..." >&2
pnpm --dir "$REPO_ROOT/packages/bobsled-core" build >/dev/null

if [[ ! -f "$CLI_BIN" ]]; then
  echo "Built CLI not found at $CLI_BIN." >&2
  exit 1
fi

if [[ "$DIALECT" == "duckdb" ]]; then
  if ! (cd "$REPO_ROOT/packages/bobsled-core" && node -e "import('@duckdb/node-api')" >/dev/null 2>&1); then
    echo "Preparing workspace dependencies and native bindings..." >&2
    pnpm --dir "$REPO_ROOT" run setup >/dev/null
  fi
fi

echo "Using bobsled CLI version $(node "$CLI_BIN" --version)" >&2

export MODE DIALECT SCRIPT_DIR PROJECT_DIR REPO_ROOT RUNNER CLI_BIN

source "$SCRIPT_DIR/_teardown.sh"
source "$SCRIPT_DIR/_pipeline.sh"

run_model_json() {
  local output_path="$1"
  shift
  (
    cd "$PROJECT_DIR" || exit 1
    node "$CLI_BIN" model "$@" --json --quiet >"$output_path"
  )
}

if [[ "$MODE" == "test" ]]; then
  teardown_state
fi

run_pipeline
