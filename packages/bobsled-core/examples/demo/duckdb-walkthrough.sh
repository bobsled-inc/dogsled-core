#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob

# ============================================================================
# dogsled Loader Walkthrough
# ============================================================================
# Demonstrates the dogsled loader pipeline: extract data from integrations (or use
# synthetic data) and load directly into DuckDB or BigQuery with typed schemas,
# merge dedup, schema evolution, retry, and structured logging.
#
# Usage:
#   ./duckdb-walkthrough.sh                              # show help
#   ./duckdb-walkthrough.sh synthetic                    # synthetic → DuckDB
#   ./duckdb-walkthrough.sh synthetic --dest bigquery    # synthetic → BigQuery
#   ./duckdb-walkthrough.sh github                       # GitHub → DuckDB
#   ./duckdb-walkthrough.sh github --dest bigquery       # GitHub → BigQuery
#   ./duckdb-walkthrough.sh notion                       # Notion → DuckDB
#   ./duckdb-walkthrough.sh linear --dest bigquery       # Linear → BigQuery
#
# BigQuery requires:
#   --bq-project, --bq-dataset (and optionally --bq-location, --bq-key-file)
#   Or set env vars: BQ_PROJECT, BQ_DATASET, BQ_LOCATION, BQ_KEY_FILE
#   Default auth: gcloud ADC (application default credentials)
#
# Loader capabilities demonstrated:
#   - Append, merge (upsert), and full_refresh load strategies
#   - Merge ordering guard (_time_extracted >= prevents stale overwrites)
#   - Schema evolution (ALTER TABLE ADD COLUMN on new fields)
#   - Structured logging (--log-format text|json)
#   - DuckDB: memory limit config, CHECKPOINT on close
#   - BigQuery: retry on transient errors, job labels, partition pruning
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Resolve dogsled CLI — prefer local build, fall back to global
if [ -x "$SCRIPT_DIR/dogsled" ]; then
  DOGSLED="$SCRIPT_DIR/dogsled"
elif [ -x "$SCRIPT_DIR/../../bin/cli.mjs" ]; then
  DOGSLED="$SCRIPT_DIR/../../bin/cli.mjs"
elif command -v bobsled >/dev/null 2>&1; then
  DOGSLED="bobsled"
elif npx --no-install bobsled --version >/dev/null 2>&1; then
  run_bobsled_with_npx() { npx --no-install bobsled "$@"; }
  DOGSLED="run_bobsled_with_npx"
else
  echo "Error: dogsled CLI not found. Install it with 'npm install @bobsled-inc/bobsled-core' in this folder or a parent folder."
  exit 1
fi

# ── Parse arguments ──────────────────────────────────────────────────────────

MODE=""
DEST="duckdb"
BQ_PROJECT="${BQ_PROJECT:-}"
BQ_DATASET="${BQ_DATASET:-}"
BQ_LOCATION="${BQ_LOCATION:-US}"
BQ_KEY_FILE="${BQ_KEY_FILE:-}"
LOG_FORMAT="${LOG_FORMAT:-text}"

while [ $# -gt 0 ]; do
  case "$1" in
    --dest)        DEST="$2"; DEST_EXPLICIT=1; shift 2 ;;
    --bq-project)  BQ_PROJECT="$2"; shift 2 ;;
    --bq-dataset)  BQ_DATASET="$2"; shift 2 ;;
    --bq-location) BQ_LOCATION="$2"; shift 2 ;;
    --bq-key-file) BQ_KEY_FILE="$2"; shift 2 ;;
    --log-format)  LOG_FORMAT="$2"; shift 2 ;;
    -h|--help)     MODE="help"; shift ;;
    *)
      if [ -z "$MODE" ]; then
        MODE="$1"
      fi
      shift ;;
  esac
done

# Colors
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
MAGENTA='\033[0;35m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# ── Helpers ──────────────────────────────────────────────────────────────────

step_num=0
step() {
  step_num=$((step_num + 1))
  echo ""
  echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "${BOLD}${CYAN}  Step $step_num: $1${RESET}"
  echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo ""
}

explain() { echo -e "  ${DIM}$1${RESET}"; }
show_command() { echo -e "  ${YELLOW}\$ $1${RESET}"; }

# Map loader log-format values (text|json) to pipeline/extractor values (pretty|json)
pipeline_log_format() {
  if [ "$LOG_FORMAT" = "json" ]; then echo "json"; else echo "pretty"; fi
}

banner() {
  echo -e "${BOLD}${GREEN}"
  echo "  ╔═══════════════════════════════════════════════════════╗"
  echo "  ║         dogsled Loader Walkthrough                    ║"
  echo "  ║  $1"
  echo "  ╚═══════════════════════════════════════════════════════╝"
  echo -e "${RESET}"
}

# ── Integration → env var mapping ────────────────────────────────────────────

env_var_for() {
  case "$1" in
    github)    echo "GITHUB_READ_TOKEN" ;;
    gitlab)    echo "GITLAB_TOKEN" ;;
    hubspot)   echo "HUBSPOT_ACCESS_TOKEN" ;;
    linear)    echo "LINEAR_API_KEY" ;;
    notion)    echo "NOTION_API_TOKEN" ;;
    pylon)     echo "PYLON_API_TOKEN" ;;
    slack)     echo "SLACK_BOT_TOKEN" ;;
    smartlead) echo "SMARTLEAD_API_KEY" ;;
    stripe)    echo "STRIPE_SECRET_KEY" ;;
    vantage)   echo "VANTAGE_API_TOKEN" ;;
    *) echo "" ;;
  esac
}

# Resources to skip — need dynamic input IDs
skip_resources_for() {
  case "$1" in
    hubspot)   echo "pipeline_stages" ;;
    notion)    echo "blocks comments database_items page_properties" ;;
    pylon)     echo "issues" ;;
    slack)     echo "messages thread_replies" ;;
    smartlead) echo "campaign_leads campaign_statistics" ;;
    *) echo "" ;;
  esac
}

# ── Destination helpers ──────────────────────────────────────────────────────

DEST_ARGS=()

set_dest_args() {
  DEST_ARGS=()

  if [ "$DEST" = "bigquery" ]; then
    DEST_ARGS=(--dest bigquery --project-id "$BQ_PROJECT" --dataset-id "$BQ_DATASET")
    [ -n "$BQ_LOCATION" ] && DEST_ARGS+=(--location "$BQ_LOCATION")
    [ -n "$BQ_KEY_FILE" ] && DEST_ARGS+=(--key-filename "$BQ_KEY_FILE")
  else
    DEST_ARGS=(--dest duckdb --db-path "$DB_PATH")
  fi
}

dest_flags_for_display() {
  local arg
  local quoted=()

  set_dest_args
  for arg in "${DEST_ARGS[@]}"; do
    quoted+=("$(printf '%q' "$arg")")
  done

  printf '%s' "${quoted[*]}"
}

dest_label() {
  if [ "$DEST" = "bigquery" ]; then
    echo "BigQuery (${BQ_PROJECT}.${BQ_DATASET})"
  else
    echo "DuckDB (${DB_PATH})"
  fi
}

# Query helper — works for both DuckDB and BigQuery via dogsled load query
query() {
  local sql="$1"
  echo -e "  ${MAGENTA}SQL:${RESET} ${DIM}${sql}${RESET}"
  echo -e "  ${GREEN}Result:${RESET}"
  set_dest_args
  "$DOGSLED" load query "${DEST_ARGS[@]}" "$sql" 2>/dev/null | sed 's/^/    /'
  echo ""
}

# Qualify a table name for the current destination
qualify() {
  local table="$1"
  if [ "$DEST" = "bigquery" ]; then
    echo "\`${BQ_PROJECT}.${BQ_DATASET}.${table}\`"
  else
    echo "main.${table}"
  fi
}

# ── Validate destination ─────────────────────────────────────────────────────

validate_dest() {
  if [ "$DEST" = "bigquery" ]; then
    if [ -z "$BQ_PROJECT" ] || [ -z "$BQ_DATASET" ]; then
      echo -e "  ${RED}BigQuery requires --bq-project and --bq-dataset${RESET}"
      echo ""
      echo -e "  ${BOLD}Option 1: CLI flags${RESET}"
      echo -e "    ${YELLOW}./duckdb-walkthrough.sh ${MODE} --dest bigquery --bq-project my-project --bq-dataset bobsled_test${RESET}"
      echo ""
      echo -e "  ${BOLD}Option 2: env vars${RESET}"
      echo -e "    ${YELLOW}export BQ_PROJECT=my-project${RESET}"
      echo -e "    ${YELLOW}export BQ_DATASET=bobsled_test${RESET}"
      echo -e "    ${YELLOW}./duckdb-walkthrough.sh ${MODE} --dest bigquery${RESET}"
      echo ""
      echo -e "  ${BOLD}Auth:${RESET}"
      echo -e "    Default: gcloud ADC ${DIM}(run: gcloud auth application-default login)${RESET}"
      echo -e "    Or pass ${YELLOW}--bq-key-file /path/to/service-account.json${RESET}"
      echo ""
      exit 1
    fi

    if [ -n "$BQ_KEY_FILE" ] && [ ! -f "$BQ_KEY_FILE" ]; then
      echo -e "  ${RED}Key file not found: ${BQ_KEY_FILE}${RESET}"
      exit 1
    fi

    echo -e "  ${BOLD}Destination:${RESET} BigQuery"
    echo -e "  ${BOLD}Project:${RESET}     ${BQ_PROJECT}"
    echo -e "  ${BOLD}Dataset:${RESET}     ${BQ_DATASET}"
    echo -e "  ${BOLD}Location:${RESET}    ${BQ_LOCATION}"
    if [ -n "$BQ_KEY_FILE" ]; then
      echo -e "  ${BOLD}Auth:${RESET}        service account key (${BQ_KEY_FILE})"
    else
      echo -e "  ${BOLD}Auth:${RESET}        gcloud ADC (application default credentials)"
    fi
    echo -e "  ${BOLD}Features:${RESET}    retry on transient errors, job labels, partition pruning"
  else
    echo -e "  ${BOLD}Destination:${RESET} DuckDB → ${DB_PATH}"
    echo -e "  ${BOLD}Features:${RESET}    memory limit, CHECKPOINT on close"
  fi
  echo -e "  ${BOLD}Log format:${RESET}  ${LOG_FORMAT}"
}

# ── Show available modes ────────────────────────────────────────────────────

if [ -z "$MODE" ] || [ "$MODE" = "help" ]; then
  echo -e "${BOLD}${GREEN}"
  echo "  dogsled Loader Walkthrough"
  echo -e "${RESET}"
  echo -e "  Usage: ${YELLOW}./duckdb-walkthrough.sh <mode> [--dest duckdb|bigquery] [options]${RESET}"
  echo ""
  echo -e "  ${BOLD}Destinations:${RESET}"
  echo -e "    ${CYAN}duckdb${RESET}      ${DIM}(default)${RESET} Local DuckDB file — zero setup"
  echo -e "    ${CYAN}bigquery${RESET}    Google BigQuery — needs project + dataset"
  echo ""
  echo -e "  ${BOLD}Options:${RESET}"
  echo -e "    ${YELLOW}--log-format${RESET}   text or json                    ${DIM}(or \$LOG_FORMAT, default: text)${RESET}"
  echo -e "    ${YELLOW}--bq-project${RESET}   GCP project ID                  ${DIM}(or \$BQ_PROJECT)${RESET}"
  echo -e "    ${YELLOW}--bq-dataset${RESET}   BigQuery dataset ID             ${DIM}(or \$BQ_DATASET)${RESET}"
  echo -e "    ${YELLOW}--bq-location${RESET}  Dataset location                ${DIM}(or \$BQ_LOCATION, default: US)${RESET}"
  echo -e "    ${YELLOW}--bq-key-file${RESET}  Service account JSON            ${DIM}(or \$BQ_KEY_FILE, default: gcloud ADC)${RESET}"
  echo ""
  echo -e "  ${BOLD}Modes:${RESET}"
  echo ""
  echo -e "    ${CYAN}synthetic${RESET}    Synthetic data demo — no API key needed"
  echo -e "                  Tests append, merge, merge ordering, full_refresh, schema evolution"
  echo ""
  echo -e "    ${CYAN}notion${RESET}       ${BOLD}★ Featured${RESET} — Notion → DuckDB or BigQuery"
  echo -e "                  Interactive destination picker, extracts pages + users,"
  echo -e "                  runs SQL queries, demonstrates idempotent re-extraction"

  NOTION_ENV=$(env_var_for "notion")
  if [ -n "$NOTION_ENV" ] && [ -n "${!NOTION_ENV:-}" ]; then
    echo -e "                  ${GREEN}\$NOTION_API_TOKEN set ✓${RESET}"
  else
    echo -e "                  ${DIM}needs \$NOTION_API_TOKEN${RESET}"
  fi
  echo ""

  for yml in "$SCRIPT_DIR"/integrations/*.yml; do
    name=$(basename "$yml" .yml)
    [ "$name" = "notion" ] && continue  # already featured above
    env=$(env_var_for "$name")
    is_set=""
    if [ -n "$env" ] && [ -n "${!env:-}" ]; then
      is_set="${GREEN}key set${RESET}"
    else
      is_set="${DIM}needs \$$env${RESET}"
    fi

    loadable=$(find "$SCRIPT_DIR/resources/$name" -maxdepth 1 -type f -name '*.yml' 2>/dev/null | wc -l | tr -d ' ')

    echo -e "    ${CYAN}${name}${RESET}$(printf '%*s' $((12 - ${#name})) '')${loadable} resources   ${is_set}"
  done

  echo ""
  echo -e "  ${BOLD}Examples:${RESET}"
  echo -e "    ${YELLOW}./duckdb-walkthrough.sh synthetic${RESET}"
  echo -e "    ${YELLOW}NOTION_API_TOKEN=ntn_xxx ./duckdb-walkthrough.sh notion${RESET}"
  echo -e "    ${YELLOW}./duckdb-walkthrough.sh notion --dest bigquery --bq-project my-proj --bq-dataset bobsled_test${RESET}"
  echo -e "    ${YELLOW}GITHUB_READ_TOKEN=ghp_xxx ./duckdb-walkthrough.sh github${RESET}"
  echo ""
  exit 0
fi

# ── Synthetic mode ──────────────────────────────────────────────────────────

if [ "$MODE" = "synthetic" ]; then
  DB_PATH="$SCRIPT_DIR/walkthrough.duckdb"

  if [ "$DEST" = "duckdb" ]; then
    rm -f "$DB_PATH" "$DB_PATH.wal"
  fi

  banner "Synthetic data → $([ "$DEST" = "bigquery" ] && echo "BigQuery" || echo "DuckDB")                ║"

  validate_dest
  echo ""

  # ── Check ──
  step "Check destination connectivity"
  explain "The 'check' command validates the destination is reachable and writable."
  if [ "$DEST" = "bigquery" ]; then
    explain "For BigQuery, this verifies the dataset exists and is accessible."
  else
    explain "For DuckDB, this creates the file if it doesn't exist and runs a test write."
  fi
  echo ""
  show_command "dogsled load check $(dest_flags_for_display)"
  echo ""
  set_dest_args
  "$DOGSLED" load check "${DEST_ARGS[@]}" 2>&1 | sed 's/^/  /'
  echo ""

  # ── Append ──
  step "Append strategy — insert 3 issues"
  explain "Protocol flow: SCHEMA message declares the stream, then RECORD messages carry data."
  explain "Each RECORD includes 'time_extracted' — the timestamp the extractor pulled it."
  explain "The loader adds '_dogsled_loaded_at' automatically when writing to the DB."
  explain "Strategy: append — all records are INSERTed. No dedup, no upsert."
  echo ""

  APPEND_INPUT='{"_v":1,"type":"SCHEMA","stream":"issues","schema":{"columns":[{"name":"id","type":"integer","primary_key":true},{"name":"title","type":"string"},{"name":"status","type":"string"},{"name":"priority","type":"integer"},{"name":"updated_at","type":"timestamp"}]},"key_properties":["id"],"load_strategy":"append","cursor_field":"updated_at"}
{"_v":1,"type":"RECORD","stream":"issues","record":{"id":1,"title":"Fix login bug","status":"open","priority":1,"updated_at":"2026-03-27T09:00:00.000Z"},"time_extracted":"2026-03-27T10:00:00.000Z"}
{"_v":1,"type":"RECORD","stream":"issues","record":{"id":2,"title":"Add dark mode","status":"in_progress","priority":2,"updated_at":"2026-03-27T09:30:00.000Z"},"time_extracted":"2026-03-27T10:00:01.000Z"}
{"_v":1,"type":"RECORD","stream":"issues","record":{"id":3,"title":"Update docs","status":"done","priority":3,"updated_at":"2026-03-27T09:45:00.000Z"},"time_extracted":"2026-03-27T10:00:02.000Z"}
{"_v":1,"type":"STATE","stream":"issues","value":{"record_count":3,"cursor":"2026-03-27T10:00:02.000Z"}}'

  echo -e "  ${DIM}Feeding protocol messages:${RESET}"
  echo "$APPEND_INPUT" | while IFS= read -r line; do
    type=$(echo "$line" | python3 -c "import sys,json; print(json.load(sys.stdin)['type'])" 2>/dev/null || echo "?")
    stream=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('stream',''))" 2>/dev/null || echo "")
    case "$type" in
      SCHEMA) echo -e "    ${CYAN}SCHEMA${RESET} stream=${stream} strategy=append keys=[id]" ;;
      RECORD)
        rec=$(echo "$line" | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin)['record']))" 2>/dev/null)
        echo -e "    ${GREEN}RECORD${RESET} stream=${stream} → ${rec}" ;;
      STATE)
        val=$(echo "$line" | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin)['value']))" 2>/dev/null)
        echo -e "    ${YELLOW}STATE${RESET}  stream=${stream} → ${val}" ;;
    esac
  done
  echo ""

  echo -e "  ${DIM}Running loader...${RESET}"
  show_command "echo '<protocol>' | dogsled load run $(dest_flags_for_display) --log-format ${LOG_FORMAT}"
  echo ""
  set_dest_args
  echo "$APPEND_INPUT" | "$DOGSLED" load run "${DEST_ARGS[@]}" --log-format "$LOG_FORMAT" 2>&1 | sed 's/^/  /'
  echo ""

  ISSUES=$(qualify "issues")
  query "SELECT id, title, status, priority FROM ${ISSUES} ORDER BY id"
  query "SELECT id, title, _time_extracted, _dogsled_loaded_at FROM ${ISSUES} ORDER BY id"

  # ── Merge ──
  step "Merge strategy — upsert with overlapping primary keys"
  explain "Strategy: merge — uses MERGE INTO with key_properties as the join condition."
  explain "Matching rows are UPDATED (id=2 gets new status). New rows are INSERTed (id=4)."
  explain "The loader deduplicates within each batch using QUALIFY ROW_NUMBER()."
  echo ""

  MERGE_INPUT='{"_v":1,"type":"SCHEMA","stream":"issues","schema":{"columns":[{"name":"id","type":"integer","primary_key":true},{"name":"title","type":"string"},{"name":"status","type":"string"},{"name":"priority","type":"integer"},{"name":"updated_at","type":"timestamp"}]},"key_properties":["id"],"load_strategy":"merge","cursor_field":"updated_at"}
{"_v":1,"type":"RECORD","stream":"issues","record":{"id":2,"title":"Add dark mode","status":"done","priority":2,"updated_at":"2026-03-27T10:30:00.000Z"},"time_extracted":"2026-03-27T11:00:00.000Z"}
{"_v":1,"type":"RECORD","stream":"issues","record":{"id":4,"title":"Refactor auth","status":"open","priority":1,"updated_at":"2026-03-27T10:45:00.000Z"},"time_extracted":"2026-03-27T11:00:01.000Z"}
{"_v":1,"type":"STATE","stream":"issues","value":{"record_count":2,"cursor":"2026-03-27T11:00:01.000Z"}}'

  echo -e "  ${DIM}Feeding merge data (id=2 updated, id=4 new):${RESET}"
  show_command "echo '<protocol>' | dogsled load run $(dest_flags_for_display) --log-format ${LOG_FORMAT}"
  echo ""
  echo -e "  ${DIM}Running loader...${RESET}"
  set_dest_args
  echo "$MERGE_INPUT" | "$DOGSLED" load run "${DEST_ARGS[@]}" --log-format "$LOG_FORMAT" 2>&1 | sed 's/^/  /'
  echo ""

  query "SELECT id, title, status, priority FROM ${ISSUES} ORDER BY id"
  explain "id=2 status changed from 'in_progress' → 'done'. id=4 is new. Total: 4 rows."
  echo ""

  # ── Merge ordering guard ──
  step "Merge ordering guard — stale data does NOT overwrite newer data"
  explain "The merge uses a timestamp guard: WHEN MATCHED AND S._time_extracted >= T._time_extracted"
  explain "This prevents an older extraction from overwriting data written by a newer one."
  explain "Here we send id=2 again but with an OLDER _time_extracted than what's in the DB."
  explain "The existing row (from 11:00:00) should survive — the stale update (09:00:00) is skipped."
  echo ""

  STALE_INPUT='{"_v":1,"type":"SCHEMA","stream":"issues","schema":{"columns":[{"name":"id","type":"integer","primary_key":true},{"name":"title","type":"string"},{"name":"status","type":"string"},{"name":"priority","type":"integer"},{"name":"updated_at","type":"timestamp"}]},"key_properties":["id"],"load_strategy":"merge","cursor_field":"updated_at"}
{"_v":1,"type":"RECORD","stream":"issues","record":{"id":2,"title":"STALE dark mode","status":"open","priority":2,"updated_at":"2026-03-27T08:00:00.000Z"},"time_extracted":"2026-03-27T09:00:00.000Z"}
{"_v":1,"type":"STATE","stream":"issues","value":{"record_count":1}}'

  echo -e "  ${DIM}Feeding stale data for id=2 (time_extracted=09:00 < existing 11:00):${RESET}"
  show_command "echo '<protocol>' | dogsled load run $(dest_flags_for_display) --log-format ${LOG_FORMAT}"
  echo ""
  set_dest_args
  echo "$STALE_INPUT" | "$DOGSLED" load run "${DEST_ARGS[@]}" --log-format "$LOG_FORMAT" 2>&1 | sed 's/^/  /'
  echo ""

  query "SELECT id, title, status, _time_extracted FROM ${ISSUES} WHERE id = 2"
  explain "id=2 still shows 'done' from the newer extraction — stale data was rejected."
  echo ""

  # ── Full refresh ──
  step "Full refresh strategy — truncate and reload"
  explain "Strategy: full_refresh — DELETEs all existing rows, then INSERTs fresh data."
  echo ""

  REFRESH_INPUT='{"_v":1,"type":"SCHEMA","stream":"issues","schema":{"columns":[{"name":"id","type":"integer","primary_key":true},{"name":"title","type":"string"},{"name":"status","type":"string"},{"name":"priority","type":"integer"},{"name":"updated_at","type":"timestamp"}]},"key_properties":["id"],"load_strategy":"full_refresh"}
{"_v":1,"type":"RECORD","stream":"issues","record":{"id":10,"title":"New issue A","status":"open","priority":1,"updated_at":"2026-03-27T11:30:00.000Z"},"time_extracted":"2026-03-27T12:00:00.000Z"}
{"_v":1,"type":"RECORD","stream":"issues","record":{"id":11,"title":"New issue B","status":"open","priority":2,"updated_at":"2026-03-27T11:45:00.000Z"},"time_extracted":"2026-03-27T12:00:01.000Z"}
{"_v":1,"type":"STATE","stream":"issues","value":{"record_count":2}}'

  echo -e "  ${DIM}Running loader...${RESET}"
  set_dest_args
  echo "$REFRESH_INPUT" | "$DOGSLED" load run "${DEST_ARGS[@]}" --log-format "$LOG_FORMAT" 2>&1 | sed 's/^/  /'
  echo ""

  query "SELECT id, title, status, priority FROM ${ISSUES} ORDER BY id"
  explain "All previous rows are gone. Only the 2 new rows remain."
  echo ""

  # ── Schema evolution ──
  step "Schema evolution — add a column to an existing table"
  explain "When the extractor sends a SCHEMA with new columns, the loader runs"
  if [ "$DEST" = "bigquery" ]; then
    explain "ALTER TABLE ADD COLUMN in BigQuery. Existing rows get NULL for the new column."
  else
    explain "ALTER TABLE ADD COLUMN automatically. Existing rows get NULL for the new column."
  fi
  echo ""

  EVOLVE_INPUT='{"_v":1,"type":"SCHEMA","stream":"issues","schema":{"columns":[{"name":"id","type":"integer","primary_key":true},{"name":"title","type":"string"},{"name":"status","type":"string"},{"name":"priority","type":"integer"},{"name":"updated_at","type":"timestamp"},{"name":"assignee","type":"string"}]},"key_properties":["id"],"load_strategy":"append"}
{"_v":1,"type":"RECORD","stream":"issues","record":{"id":12,"title":"With assignee","status":"open","priority":1,"updated_at":"2026-03-27T13:00:00.000Z","assignee":"alex"},"time_extracted":"2026-03-27T13:00:00.000Z"}'

  echo -e "  ${DIM}Running loader with new 'assignee' column...${RESET}"
  set_dest_args
  echo "$EVOLVE_INPUT" | "$DOGSLED" load run "${DEST_ARGS[@]}" --log-format "$LOG_FORMAT" 2>&1 | sed 's/^/  /'
  echo ""

  query "SELECT id, title, assignee FROM ${ISSUES} ORDER BY id"
  explain "Old rows have NULL assignee. New row has 'alex'."
  echo ""

  # ── Done ──
  echo ""
  echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "${BOLD}${GREEN}  Synthetic walkthrough complete!${RESET}"
  echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo ""
  echo -e "  Destination: ${BOLD}$(dest_label)${RESET}"
  echo ""
  echo -e "  ${BOLD}What was demonstrated:${RESET}"
  echo -e "    1. ${CYAN}append${RESET}         — insert all records"
  echo -e "    2. ${CYAN}merge${RESET}          — upsert by primary key"
  echo -e "    3. ${CYAN}ordering guard${RESET} — stale _time_extracted does NOT overwrite newer data"
  echo -e "    4. ${CYAN}full_refresh${RESET}   — truncate + reload"
  echo -e "    5. ${CYAN}schema evolution${RESET} — ALTER TABLE ADD COLUMN on new fields"
  echo ""
  if [ "$DEST" = "duckdb" ]; then
    echo -e "  ${DIM}Explore:${RESET}"
    echo -e "    ${YELLOW}$ dogsled load check --dest duckdb --db-path ./walkthrough.duckdb${RESET}"
    echo -e "    ${YELLOW}$ dogsled load query --db-path ./walkthrough.duckdb \"DESCRIBE main.issues\"${RESET}"
    echo -e "    ${YELLOW}$ dogsled load query --db-path ./walkthrough.duckdb \"SELECT * FROM main.issues\"${RESET}"
  else
    echo -e "  ${DIM}Explore:${RESET}"
    echo -e "    ${YELLOW}$ dogsled load check --dest bigquery --project-id ${BQ_PROJECT} --dataset-id ${BQ_DATASET}${RESET}"
    echo -e "    ${YELLOW}\$ bq query --nouse_legacy_sql 'SELECT * FROM \`${BQ_PROJECT}.${BQ_DATASET}.issues\` LIMIT 10'${RESET}"
  fi
  echo ""
  echo -e "  ${DIM}Try with structured JSON logs:${RESET}"
  echo -e "    ${YELLOW}./duckdb-walkthrough.sh synthetic --log-format json${RESET}"
  echo ""
  exit 0
fi

# ── Notion walkthrough mode ────────────────────────────────────────────────

if [ "$MODE" = "notion" ]; then

  # ── Check for API token ──
  if [ -z "${NOTION_API_TOKEN:-}" ]; then
    echo ""
    echo -e "  ${RED}Missing Notion API token.${RESET}"
    echo ""
    echo -e "  ${BOLD}How to get one:${RESET}"
    echo -e "    1. Open your Notion integration settings"
    echo -e "    2. Click ${BOLD}New integration${RESET} → give it a name → ${BOLD}Submit${RESET}"
    echo -e "    3. Copy the ${BOLD}Internal Integration Secret${RESET} (starts with ntn_)"
    echo -e "    4. In Notion, open a page → ••• → ${BOLD}Connections${RESET} → add your integration"
    echo ""
    echo -e "  ${BOLD}Then run:${RESET}"
    echo -e "    ${YELLOW}NOTION_API_TOKEN=ntn_xxx ./duckdb-walkthrough.sh notion${RESET}"
    echo ""
    exit 1
  fi

  # ── Interactive destination picker (unless --dest was passed) ──
  if [ "$DEST" = "duckdb" ] && [ -z "${DEST_EXPLICIT:-}" ]; then
    echo ""
    echo -e "  ${BOLD}Where do you want to load your Notion data?${RESET}"
    echo ""
    echo -e "    ${CYAN}1${RESET})  DuckDB   ${DIM}— local file, zero setup (default)${RESET}"
    echo -e "    ${CYAN}2${RESET})  BigQuery ${DIM}— needs GCP project + dataset${RESET}"
    echo ""
    printf "  Choose [1]: "
    read -r dest_choice </dev/tty
    echo ""

    case "${dest_choice:-1}" in
      2|bigquery|bq)
        DEST="bigquery"
        if [ -z "$BQ_PROJECT" ]; then
          printf "  ${BOLD}GCP Project ID:${RESET} "
          read -r BQ_PROJECT </dev/tty
        fi
        if [ -z "$BQ_DATASET" ]; then
          printf "  ${BOLD}BigQuery Dataset:${RESET} "
          read -r BQ_DATASET </dev/tty
        fi
        if [ -z "$BQ_PROJECT" ] || [ -z "$BQ_DATASET" ]; then
          echo -e "  ${RED}Project and dataset are required for BigQuery.${RESET}"
          exit 1
        fi
        echo ""
        ;;
      *) DEST="duckdb" ;;
    esac
  fi

  DB_PATH="$SCRIPT_DIR/notion.duckdb"

  if [ "$DEST" = "duckdb" ]; then
    rm -f "$DB_PATH" "$DB_PATH.wal"
  fi

  banner "Notion → $([ "$DEST" = "bigquery" ] && echo "BigQuery" || echo "DuckDB")                          ║"

  echo -e "  ${BOLD}Integration:${RESET} Notion"
  echo -e "  ${BOLD}Auth:${RESET}        \$NOTION_API_TOKEN ${GREEN}set${RESET}"
  validate_dest
  echo -e "  ${BOLD}Resources:${RESET}   pages, users"
  echo -e "  ${BOLD}Skipped:${RESET}     ${DIM}blocks, comments, database_items, page_properties (need parent IDs)${RESET}"
  echo ""

  # ── Step 1: Check connectivity ──
  step "Check destination connectivity"
  if [ "$DEST" = "bigquery" ]; then
    explain "Verifying BigQuery dataset exists and is writable."
  else
    explain "Creating DuckDB file and verifying it's writable."
  fi
  echo ""
  show_command "dogsled load check $(dest_flags_for_display)"
  echo ""
  set_dest_args
  "$DOGSLED" load check "${DEST_ARGS[@]}" 2>&1 | sed 's/^/  /'
  echo ""

  # ── Step 2: Extract users ──
  step "Extract Notion users"
  explain "Hitting Notion's /v1/users endpoint to pull all workspace members."
  explain "This returns person-type users (humans) and bot-type users (integrations)."
  explain "The extractor emits SCHEMA → RECORD → STATE protocol messages on stdout."
  explain "The loader reads them, creates the 'users' table, and inserts rows."
  echo ""

  PIPE_FMT=$(pipeline_log_format)
  set_dest_args
  cmd="dogsled pipeline --integration notion $(dest_flags_for_display) --log-format ${PIPE_FMT} users"
  show_command "$cmd"
  echo ""

  if "$DOGSLED" pipeline \
      --integration notion \
      "${DEST_ARGS[@]}" \
      --log-format "$PIPE_FMT" \
      users 2>&1 | sed 's/^/  /'; then
    echo -e "  ${GREEN}✓ users loaded${RESET}"
  else
    echo -e "  ${RED}✗ users failed${RESET}"
  fi
  echo ""

  # ── Step 3: Extract pages ──
  step "Extract Notion pages"
  explain "Searching all pages the integration can see via /v1/search."
  explain "Returns page metadata: id, url, parent, created/edited timestamps."
  explain "The loader creates the 'pages' table with typed columns and primary key."
  echo ""

  set_dest_args
  cmd="dogsled pipeline --integration notion $(dest_flags_for_display) --log-format ${PIPE_FMT} pages"
  show_command "$cmd"
  echo ""

  if "$DOGSLED" pipeline \
      --integration notion \
      "${DEST_ARGS[@]}" \
      --log-format "$PIPE_FMT" \
      pages 2>&1 | sed 's/^/  /'; then
    echo -e "  ${GREEN}✓ pages loaded${RESET}"
  else
    echo -e "  ${RED}✗ pages failed${RESET}"
  fi
  echo ""

  # ── Step 4: Explore what landed ──
  step "Explore loaded data"
  echo ""

  USERS=$(qualify "users")
  PAGES=$(qualify "pages")

  echo -e "  ${BOLD}Users table:${RESET}"
  query "SELECT count(*) as total_users FROM ${USERS}"

  echo -e "  ${BOLD}All users:${RESET}"
  query "SELECT id, name, type, email FROM ${USERS} ORDER BY name"

  echo -e "  ${BOLD}Pages table:${RESET}"
  query "SELECT count(*) as total_pages FROM ${PAGES}"

  echo -e "  ${BOLD}Recent pages (last 10 edited):${RESET}"
  query "SELECT id, url, parent_type, last_edited_time FROM ${PAGES} ORDER BY last_edited_time DESC LIMIT 10"

  echo -e "  ${BOLD}Pages by parent type:${RESET}"
  query "SELECT parent_type, count(*) as cnt FROM ${PAGES} GROUP BY parent_type ORDER BY cnt DESC"

  if [ "$DEST" = "duckdb" ]; then
    echo -e "  ${BOLD}Table schemas:${RESET}"
    query "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'main' ORDER BY table_name, ordinal_position"
  fi

  # ── Step 5: Re-extract to demonstrate idempotent reload ──
  step "Re-extract pages (idempotent full_refresh)"
  explain "Running the same extraction again. Notion pages use full_refresh strategy"
  explain "(no incremental cursor), so the loader DELETEs existing rows and re-INSERTs."
  explain "This is safe and idempotent — same data, same row count, fresh timestamps."
  echo ""

  set_dest_args
  cmd="dogsled pipeline --integration notion $(dest_flags_for_display) --log-format ${PIPE_FMT} pages"
  show_command "$cmd"
  echo ""

  if "$DOGSLED" pipeline \
      --integration notion \
      "${DEST_ARGS[@]}" \
      --log-format "$PIPE_FMT" \
      pages 2>&1 | sed 's/^/  /'; then
    echo -e "  ${GREEN}✓ pages re-loaded (full_refresh)${RESET}"
  else
    echo -e "  ${RED}✗ pages re-extract failed${RESET}"
  fi
  echo ""

  query "SELECT count(*) as total_pages FROM ${PAGES}"
  explain "Row count is the same — full_refresh replaced all rows with fresh data."
  echo ""

  # ── Done ──
  echo ""
  echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "${BOLD}${GREEN}  Notion walkthrough complete!${RESET}"
  echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo ""
  echo -e "  Destination: ${BOLD}$(dest_label)${RESET}"
  echo ""
  echo -e "  ${BOLD}What was demonstrated:${RESET}"
  echo -e "    1. ${CYAN}users${RESET}         — extracted all workspace members"
  echo -e "    2. ${CYAN}pages${RESET}         — extracted all visible pages"
  echo -e "    3. ${CYAN}queries${RESET}       — SQL analysis of loaded data"
  echo -e "    4. ${CYAN}full_refresh${RESET}  — idempotent re-extraction replaced all rows"
  echo ""
  if [ "$DEST" = "duckdb" ]; then
    echo -e "  ${DIM}Explore further:${RESET}"
    echo -e "    ${YELLOW}$ dogsled load query --db-path ./notion.duckdb \"SELECT * FROM main.users\"${RESET}"
    echo -e "    ${YELLOW}$ dogsled load query --db-path ./notion.duckdb \"SELECT * FROM main.pages LIMIT 20\"${RESET}"
    echo -e "    ${YELLOW}$ dogsled load query --db-path ./notion.duckdb \"DESCRIBE main.pages\"${RESET}"
  else
    echo -e "  ${DIM}Explore further:${RESET}"
    echo -e "    ${YELLOW}\$ bq query --nouse_legacy_sql 'SELECT * FROM \`${BQ_PROJECT}.${BQ_DATASET}.users\`'${RESET}"
    echo -e "    ${YELLOW}\$ bq query --nouse_legacy_sql 'SELECT * FROM \`${BQ_PROJECT}.${BQ_DATASET}.pages\` LIMIT 20'${RESET}"
  fi
  echo ""
  if [ "$DEST" = "duckdb" ]; then
    echo -e "  ${DIM}Try loading to BigQuery instead:${RESET}"
    echo -e "    ${YELLOW}./duckdb-walkthrough.sh notion --dest bigquery --bq-project my-proj --bq-dataset bobsled_test${RESET}"
  else
    echo -e "  ${DIM}Try loading to DuckDB instead:${RESET}"
    echo -e "    ${YELLOW}./duckdb-walkthrough.sh notion${RESET}"
  fi
  echo ""
  exit 0
fi

# ── Live integration mode ───────────────────────────────────────────────────

INTEGRATION="$MODE"
INTEGRATION_FILE="$SCRIPT_DIR/integrations/${INTEGRATION}.yml"

if [ ! -f "$INTEGRATION_FILE" ]; then
  echo -e "  ${RED}Unknown integration: ${INTEGRATION}${RESET}"
  echo ""
  echo -e "  Available integrations:"
  for yml in "$SCRIPT_DIR"/integrations/*.yml; do
    echo -e "    ${CYAN}$(basename "$yml" .yml)${RESET}"
  done
  echo ""
  exit 1
fi

ENV_VAR=$(env_var_for "$INTEGRATION")
if [ -z "${!ENV_VAR:-}" ]; then
  echo -e "  ${RED}Missing required env var: \$${ENV_VAR}${RESET}"
  echo ""
  echo -e "  Run with:"
  echo -e "    ${YELLOW}${ENV_VAR}=<your-key> ./duckdb-walkthrough.sh ${INTEGRATION}${RESET}"
  echo ""
  exit 1
fi

DB_PATH="$SCRIPT_DIR/${INTEGRATION}.duckdb"

if [ "$DEST" = "duckdb" ]; then
  rm -f "$DB_PATH" "$DB_PATH.wal"
fi

SKIP_LIST=$(skip_resources_for "$INTEGRATION")
RESOURCE_DIR="$SCRIPT_DIR/resources/$INTEGRATION"

if [ ! -d "$RESOURCE_DIR" ]; then
  echo -e "  ${RED}Missing resources for integration: ${INTEGRATION}${RESET}"
  exit 1
fi

# Build resource list (all minus skipped)
ALL_RESOURCES=()
SKIPPED=()
for yml in "$RESOURCE_DIR"/*.yml; do
  r=$(basename "$yml" .yml)
  skip=false
  for s in $SKIP_LIST; do
    if [ "$r" = "$s" ]; then skip=true; break; fi
  done
  if $skip; then
    SKIPPED+=("$r")
  else
    ALL_RESOURCES+=("$r")
  fi
done

DEST_LABEL=$([ "$DEST" = "bigquery" ] && echo "BigQuery" || echo "DuckDB")
banner "Live: ${INTEGRATION} → ${DEST_LABEL}                          ║"

echo -e "  ${BOLD}Integration:${RESET} ${INTEGRATION}"
echo -e "  ${BOLD}Auth:${RESET}        \$${ENV_VAR} ${GREEN}set${RESET}"
validate_dest
echo -e "  ${BOLD}Resources:${RESET}   ${ALL_RESOURCES[*]}"
if [ ${#SKIPPED[@]} -gt 0 ]; then
  echo -e "  ${BOLD}Skipped:${RESET}     ${DIM}${SKIPPED[*]} (need dynamic input IDs)${RESET}"
fi
echo ""

# ── Step 1: Check connectivity ──
step "Check destination connectivity"
show_command "dogsled load check $(dest_flags_for_display)"
echo ""
set_dest_args
"$DOGSLED" load check "${DEST_ARGS[@]}" 2>&1 | sed 's/^/  /'
echo ""

# ── Step 2: Run pipeline for each resource ──
step "Extract ${INTEGRATION} → ${DEST_LABEL} via pipeline"
explain "Running 'dogsled pipeline' for each resource. This pipes extractor output"
explain "directly into the ${DEST_LABEL} loader in a single streaming pass."
explain ""
explain "What happens under the hood:"
explain "  1. Extractor reads the resource YAML spec"
explain "  2. Hits the ${INTEGRATION} API using \$${ENV_VAR} for auth"
explain "  3. Emits SCHEMA → RECORD → STATE protocol messages on stdout"
explain "  4. Loader reads stdin, creates/evolves tables, and writes rows to ${DEST_LABEL}"
if [ "$DEST" = "bigquery" ]; then
  explain "  5. BigQuery calls are retried on transient errors (429, 5xx, network)"
  explain "  6. Staging tables get 1-hour TTL for cleanup safety"
fi
echo ""

total=${#ALL_RESOURCES[@]}
current=0
failed=()

for resource in "${ALL_RESOURCES[@]}"; do
  current=$((current + 1))
  echo -e "  ${BOLD}[${current}/${total}]${RESET} ${CYAN}${resource}${RESET}"
  echo ""

  PIPE_FMT=$(pipeline_log_format)
  set_dest_args
  cmd="dogsled pipeline --integration ${INTEGRATION} $(dest_flags_for_display) --log-format ${PIPE_FMT} ${resource}"
  show_command "$cmd"
  echo ""

  if "$DOGSLED" pipeline \
      --integration "$INTEGRATION" \
      "${DEST_ARGS[@]}" \
      --log-format "$PIPE_FMT" \
      "$resource" 2>&1 | sed 's/^/    /'; then
    echo -e "    ${GREEN}${resource} loaded${RESET}"
  else
    echo -e "    ${RED}${resource} failed${RESET}"
    failed+=("$resource")
  fi
  echo ""
done

# ── Step 3: Show what landed ──
step "Inspect loaded data"
explain "Querying ${DEST_LABEL} to see what tables were created and row counts."
echo ""

if [ "$DEST" = "duckdb" ]; then
  query "SELECT table_name, estimated_size AS est_rows FROM duckdb_tables() WHERE schema_name = 'main' ORDER BY table_name"

  for resource in "${ALL_RESOURCES[@]}"; do
    table_exists=$("$DOGSLED" load query --db-path "$DB_PATH" "SELECT count(*) as c FROM information_schema.tables WHERE table_schema='main' AND table_name='${resource}'" 2>/dev/null | grep -c "1" || true)
    if [ "$table_exists" -gt 0 ]; then
      count=$("$DOGSLED" load query --db-path "$DB_PATH" "SELECT count(*) as total FROM main.${resource}" 2>/dev/null | tail -1 | tr -d ' ')
      echo -e "  ${BOLD}${resource}${RESET}: ${count} rows"
      echo -e "  ${DIM}Columns:${RESET}"
      "$DOGSLED" load query --db-path "$DB_PATH" "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='main' AND table_name='${resource}' ORDER BY ordinal_position" 2>/dev/null | sed 's/^/    /'
      echo ""
      echo -e "  ${DIM}Sample (first 3 rows):${RESET}"
      "$DOGSLED" load query --db-path "$DB_PATH" "SELECT * FROM main.${resource} LIMIT 3" 2>/dev/null | sed 's/^/    /'
      echo ""
    fi
  done
else
  for resource in "${ALL_RESOURCES[@]}"; do
    echo -e "  ${BOLD}${resource}${RESET}:"
    query "SELECT count(*) as total FROM \`${BQ_PROJECT}.${BQ_DATASET}.${resource}\`"
    echo -e "  ${DIM}Sample (first 3 rows):${RESET}"
    query "SELECT * FROM \`${BQ_PROJECT}.${BQ_DATASET}.${resource}\` LIMIT 3"
  done
fi

# ── Summary ──
echo ""
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
if [ ${#failed[@]} -eq 0 ]; then
  echo -e "${BOLD}${GREEN}  All ${total} resources loaded successfully!${RESET}"
else
  echo -e "${BOLD}${YELLOW}  ${total} resources attempted, ${#failed[@]} failed: ${failed[*]}${RESET}"
fi
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
echo -e "  Destination: ${BOLD}$(dest_label)${RESET}"
echo ""
if [ "$DEST" = "duckdb" ]; then
  echo -e "  ${DIM}Explore further:${RESET}"
  echo -e "    ${YELLOW}$ dogsled load check --dest duckdb --db-path ./${INTEGRATION}.duckdb${RESET}"
  echo -e "    ${YELLOW}$ dogsled load query --db-path ./${INTEGRATION}.duckdb \"SELECT table_name FROM duckdb_tables() WHERE schema_name='main'\"${RESET}"
  echo -e "    ${YELLOW}$ dogsled load query --db-path ./${INTEGRATION}.duckdb \"SELECT * FROM main.<table> LIMIT 10\"${RESET}"
  echo -e "    ${YELLOW}$ dogsled load query --db-path ./${INTEGRATION}.duckdb \"DESCRIBE main.<table>\"${RESET}"
else
  echo -e "  ${DIM}Explore further:${RESET}"
  echo -e "    ${YELLOW}$ dogsled load check --dest bigquery --project-id ${BQ_PROJECT} --dataset-id ${BQ_DATASET}${RESET}"
  echo -e "    ${YELLOW}\$ bq query --nouse_legacy_sql 'SELECT * FROM \`${BQ_PROJECT}.${BQ_DATASET}.<table>\` LIMIT 10'${RESET}"
  echo -e "    ${YELLOW}\$ bq show ${BQ_PROJECT}:${BQ_DATASET}.<table>${RESET}"
fi
echo ""
echo -e "  ${DIM}Re-run with different options:${RESET}"
echo -e "    ${YELLOW}./duckdb-walkthrough.sh ${INTEGRATION} --log-format json${RESET}          ${DIM}# structured JSON logs${RESET}"
if [ "$DEST" = "duckdb" ]; then
  echo -e "    ${YELLOW}./duckdb-walkthrough.sh ${INTEGRATION} --dest bigquery --bq-project ... --bq-dataset ...${RESET}"
fi
echo ""
