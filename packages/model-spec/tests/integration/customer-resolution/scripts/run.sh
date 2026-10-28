#!/usr/bin/env bash
set -euo pipefail

MODE="illustrative"
DIALECT="duckdb"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      if [[ $# -lt 2 || -z "${2:-}" || "${2:-}" == -* ]]; then
        echo "--mode requires a value" >&2
        exit 2
      fi
      MODE="${2:-}"
      shift 2
      ;;
    --dialect)
      if [[ $# -lt 2 || -z "${2:-}" || "${2:-}" == -* ]]; then
        echo "--dialect requires a value" >&2
        exit 2
      fi
      DIALECT="${2:-}"
      shift 2
      ;;
    --help|-h)
      cat <<'EOF'
Usage:
  bash scripts/run.sh [--mode illustrative|test] [--dialect duckdb|bigquery]

Defaults:
  --mode illustrative
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

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd -- "$PROJECT_DIR/../../../../.." && pwd)"
BMS_BIN="$REPO_ROOT/packages/model-spec/src/index.ts"
TSX_BIN="$REPO_ROOT/node_modules/.bin/tsx"
ENTITY_GRAPH_BIN="$REPO_ROOT/packages/entity-graph/dist/index.js"
RUNNER="$PROJECT_DIR/runner.${DIALECT}.js"

if [[ ! -d "$REPO_ROOT/node_modules" ]]; then
  echo "Dependencies are not installed. Run 'pnpm install' from $REPO_ROOT first." >&2
  exit 1
fi

if [[ ! -x "$TSX_BIN" ]]; then
  echo "tsx is not available at $TSX_BIN. Run 'pnpm install' from $REPO_ROOT first." >&2
  exit 1
fi

if [[ ! -f "$RUNNER" ]]; then
  echo "Runner not found: $RUNNER" >&2
  exit 1
fi

if [[ "$DIALECT" == "bigquery" && ! -f "$PROJECT_DIR/runner.config.json" ]]; then
  echo "BigQuery requires runner.config.json. Copy runner.config.json.example and fill in credentials." >&2
  exit 1
fi

if [[ "$DIALECT" == "duckdb" ]]; then
  if ! (cd "$REPO_ROOT/packages/dogsled" && node -e "import('@duckdb/node-api')" >/dev/null 2>&1); then
    echo "DuckDB native bindings not found. Run 'pnpm install' from $REPO_ROOT first." >&2
    exit 1
  fi
fi

if [[ ! -f "$ENTITY_GRAPH_BIN" ]]; then
  echo "Entity Graph CLI not built. Run 'pnpm build' from $REPO_ROOT first." >&2
  exit 1
fi

export MODE DIALECT SCRIPT_DIR PROJECT_DIR REPO_ROOT BMS_BIN ENTITY_GRAPH_BIN RUNNER TSX_BIN

source "$SCRIPT_DIR/_teardown.sh"
source "$SCRIPT_DIR/_pipeline.sh"

teardown_state

run_pipeline
