#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────────
# dogsled demo walkthrough
#
# Detects which API tokens are set, extracts data from those integrations to local
# parquet, compiles Model Spec models, and (if duckdb is installed) runs sample
# analytics queries against the modeled data.
#
# Usage:
#   export GITHUB_READ_TOKEN='ghp_...'
#   export SLACK_BOT_TOKEN='xoxb-...'
#   export NOTION_API_TOKEN='ntn_...'
#   export LINEAR_API_KEY='lin_api_...'
#   ./walkthrough.sh
# ──────────────────────────────────────────────────────────────────────────────

if [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "This walkthrough needs bash 4 or later (macOS ships bash 3.2; install a newer one with 'brew install bash')." >&2
  exit 1
fi

if ! command -v dogsled >/dev/null 2>&1; then
  if npx --no-install dogsled --version >/dev/null 2>&1; then
    dogsled() { npx --no-install dogsled "$@"; }
  else
    echo "dogsled CLI not found. Install it with 'npm install @bobsled-inc/bobsled-core' in this folder or a parent folder." >&2
    exit 1
  fi
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-$ROOT_DIR/output}"
COMPILED_DIR="$ROOT_DIR/compiled"
COMPILED_SQL_DIR="$COMPILED_DIR/warehouse"
DUCKDB_PATH="$OUTPUT_DIR/demo.duckdb"

cd "$ROOT_DIR"

# ── Token detection ──────────────────────────────────────────────────────────

declare -A INTEGRATION_TOKENS=(
  [github]="${GITHUB_READ_TOKEN:-}"
  [slack]="${SLACK_BOT_TOKEN:-}"
  [notion]="${NOTION_API_TOKEN:-}"
  [linear]="${LINEAR_API_KEY:-}"
)

# integration → resource list (space-separated)
declare -A INTEGRATION_RESOURCES=(
  [github]="repos"
  [slack]="channels users"
  [notion]="users pages"
  [linear]="issues teams"
)

# integration → extra pipeline flags
declare -A INTEGRATION_INPUT=(
  [github]="--input org=octocat"
  [slack]=""
  [notion]=""
  [linear]="--input updated_after=$(date -u -v-30d +%Y-%m-%dT00:00:00Z 2>/dev/null || date -u -d '30 days ago' +%Y-%m-%dT00:00:00Z)"
)

ACTIVE_INTEGRATIONS=()
for integration in github slack notion linear; do
  if [ -n "${INTEGRATION_TOKENS[$integration]}" ]; then
    ACTIVE_INTEGRATIONS+=("$integration")
  fi
done

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                 dogsled demo walkthrough                    ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo

if [ ${#ACTIVE_INTEGRATIONS[@]} -eq 0 ]; then
  echo "No API tokens detected. Set one or more of these and rerun:"
  echo
  echo "  export GITHUB_READ_TOKEN='ghp_...'"
  echo "  export SLACK_BOT_TOKEN='xoxb-...'"
  echo "  export NOTION_API_TOKEN='ntn_...'"
  echo "  export LINEAR_API_KEY='lin_api_...'"
  echo
  echo "  ./walkthrough.sh"
  exit 0
fi

echo "Detected tokens for: ${ACTIVE_INTEGRATIONS[*]}"
echo

# ── Step 1: Validate ─────────────────────────────────────────────────────────

echo "── Step 1: Validate extractor specs and Model Spec models ──"
for integration in "${ACTIVE_INTEGRATIONS[@]}"; do
  dogsled extract validate "$integration"
done
dogsled model validate
echo

# ── Step 1.5: Test auth ──────────────────────────────────────────────────────

echo "── Step 1.5: Test API auth ──"
for integration in "${ACTIVE_INTEGRATIONS[@]}"; do
  dogsled extract scaffold-test "$integration" || echo "  scaffold test failed for $integration"
done
echo

# ── Step 2: Extract ──────────────────────────────────────────────────────────

echo "── Step 2: Extract data to local parquet ──"
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

for integration in "${ACTIVE_INTEGRATIONS[@]}"; do
  for resource in ${INTEGRATION_RESOURCES[$integration]}; do
    echo "  extracting $integration/$resource ..."
    # shellcheck disable=SC2086
    dogsled pipeline "$resource" \
      --integration "$integration" \
      --format parquet \
      --output-dir "$OUTPUT_DIR" \
      ${INTEGRATION_INPUT[$integration]}
  done
done

echo
echo "Parquet files:"
find "$OUTPUT_DIR" -name '*.parquet' -type f | sort
echo

# ── Step 3: Compile models ───────────────────────────────────────────────────

echo "── Step 3: Compile Model Spec models to SQL ──"
rm -rf "$COMPILED_DIR"
mkdir -p "$COMPILED_DIR"
dogsled model compile -o "$COMPILED_DIR"
echo
echo "Models and compiled SQL:"
for sql_file in $(find "$COMPILED_DIR" -name '*.sql' -type f | sort); do
  model_name="$(basename "$sql_file" .sql)"
  yaml_file="$ROOT_DIR/models/$(echo "$model_name" | tr '[:upper:]' '[:lower:]').yml"
  echo
  echo "════════════════════════════════════════════════════════════════"
  echo "  Model: $model_name"
  echo "════════════════════════════════════════════════════════════════"
  if [ -f "$yaml_file" ]; then
    echo
    echo "── Model Spec spec ($model_name.yml) ──"
    cat "$yaml_file"
  fi
  echo
  echo "── Compiled SQL ($(basename "$sql_file")) ──"
  cat "$sql_file"
done
echo

# ── Step 4: DuckDB ───────────────────────────────────────────────────────────

if ! command -v duckdb >/dev/null 2>&1; then
  echo "── Step 4: DuckDB not installed — skipping query step ──"
  echo
  echo "Install with:  brew install duckdb"
  echo "Then rerun:    ./walkthrough.sh"
  echo
  echo "Done! Parquet and compiled SQL are ready for manual use."
  exit 0
fi

echo "── Step 4: Load into DuckDB and run sample queries ──"
rm -f "$DUCKDB_PATH"

duckdb "$DUCKDB_PATH" <<SQL
CREATE SCHEMA IF NOT EXISTS raw;
CREATE SCHEMA IF NOT EXISTS analytics;
SQL

# ── Raw views from parquet ───────────────────────────────────────────────────

# Resource name → raw table name mapping
declare -A RAW_TABLE=(
  [repos]=github_repos
  [channels]=slack_channels
  [users_slack]=slack_users
  [users_notion]=notion_users
  [pages]=notion_pages
  [issues]=linear_issues
  [teams]=linear_teams
)

# Track which raw tables were successfully created
declare -A RAW_CREATED=()

for integration in "${ACTIVE_INTEGRATIONS[@]}"; do
  for resource in ${INTEGRATION_RESOURCES[$integration]}; do
    # Disambiguate 'users' across integrations
    if [ "$resource" = "users" ]; then
      table_key="users_${integration}"
    else
      table_key="$resource"
    fi
    raw_table="${RAW_TABLE[$table_key]}"
    parquet_path="$OUTPUT_DIR/$resource/*.parquet"

    if ls $parquet_path 1>/dev/null 2>&1; then
      RAW_SQL="CREATE OR REPLACE VIEW raw.${raw_table} AS
SELECT * FROM read_parquet('${parquet_path}');"
      echo "  ▸ raw.${raw_table} ← $resource/*.parquet"
      echo "    SQL: CREATE OR REPLACE VIEW raw.${raw_table} AS SELECT * FROM read_parquet('$resource/*.parquet');"
      duckdb "$DUCKDB_PATH" <<< "$RAW_SQL"
      RAW_CREATED[$raw_table]=1
    else
      echo "  (skipped raw.${raw_table} — no parquet files for $resource)"
    fi
  done
done
echo

# ── Compiled model views ─────────────────────────────────────────────────────

# Model → raw table dependency (lowercase raw table name)
declare -A MODEL_DEPENDS_ON=(
  [STG_GITHUB_REPOS]=github_repos
  [STG_SLACK_CHANNELS]=slack_channels
  [STG_SLACK_USERS]=slack_users
  [STG_NOTION_PAGES]=notion_pages
  [STG_NOTION_USERS]=notion_users
  [STG_LINEAR_ISSUES]=linear_issues
  [REPO_VISIBILITY_SUMMARY]=github_repos
  [CHANNEL_ACTIVITY_SUMMARY]=slack_channels
  [PAGE_ACTIVITY_SUMMARY]=notion_pages
  [ISSUE_SUMMARY_BY_TEAM]=linear_issues
)

# Staging models (must run before summary models)
declare -A STG_MODELS=(
  [github]=STG_GITHUB_REPOS
  [slack]="STG_SLACK_CHANNELS STG_SLACK_USERS"
  [notion]="STG_NOTION_PAGES STG_NOTION_USERS"
  [linear]=STG_LINEAR_ISSUES
)

# Summary models (depend on staging)
declare -A SUMMARY_MODELS=(
  [github]=REPO_VISIBILITY_SUMMARY
  [slack]=CHANNEL_ACTIVITY_SUMMARY
  [notion]=PAGE_ACTIVITY_SUMMARY
  [linear]=ISSUE_SUMMARY_BY_TEAM
)

deploy_model() {
  local model="$1"
  local sql_file="$COMPILED_SQL_DIR/${model}.sql"
  local dep="${MODEL_DEPENDS_ON[$model]:-}"

  if [ ! -f "$sql_file" ]; then
    return
  fi

  # Skip if the raw table this model depends on was not created
  if [ -n "$dep" ] && [ -z "${RAW_CREATED[$dep]:-}" ]; then
    echo "  (skipped analytics.$(echo "$model" | tr '[:upper:]' '[:lower:]') — raw.${dep} not available)"
    return
  fi

  echo "  ▸ Running SQL for analytics.$(echo "$model" | tr '[:upper:]' '[:lower:]'):"
  echo "    $(head -1 "$sql_file")..."
  duckdb "$DUCKDB_PATH" < "$sql_file"
  echo "    ✓ created"
}

echo "Deploying compiled models:"
for integration in "${ACTIVE_INTEGRATIONS[@]}"; do
  for model in ${STG_MODELS[$integration]}; do
    deploy_model "$model"
  done
  for model in ${SUMMARY_MODELS[$integration]}; do
    deploy_model "$model"
  done
done
echo

# ── Sample queries ───────────────────────────────────────────────────────────

echo "── Sample queries ──"
echo

run_query() {
  local label="$1"
  local sql="$2"
  echo "▸ $label"
  echo
  echo "  SQL:"
  echo "$sql" | sed 's/^/    /'
  echo
  duckdb "$DUCKDB_PATH" -cmd ".mode box" "$sql" 2>/dev/null || true
  echo
}

for integration in "${ACTIVE_INTEGRATIONS[@]}"; do
  case "$integration" in
    github)
      if [ -n "${RAW_CREATED[github_repos]:-}" ]; then
        run_query "GitHub: Top repos by stars" \
          "SELECT repo_name, visibility, language, stargazers_count, forks_count FROM analytics.stg_github_repos ORDER BY stargazers_count DESC LIMIT 10;"
        run_query "GitHub: Repos by visibility & language" \
          "SELECT visibility, language, repo_count, total_stars, total_forks FROM analytics.repo_visibility_summary ORDER BY repo_count DESC LIMIT 10;"
      fi
      ;;
    slack)
      if [ -n "${RAW_CREATED[slack_channels]:-}" ]; then
        run_query "Slack: Largest channels" \
          "SELECT channel_name, num_members, is_public, is_archived FROM analytics.stg_slack_channels ORDER BY num_members DESC LIMIT 10;"
        run_query "Slack: Channel summary by visibility" \
          "SELECT is_public, channel_count, total_members, avg_members, archived_count FROM analytics.channel_activity_summary ORDER BY channel_count DESC;"
      fi
      ;;
    notion)
      if [ -n "${RAW_CREATED[notion_pages]:-}" ]; then
        run_query "Notion: Recently edited pages" \
          "SELECT page_id, parent_type, is_archived, last_edited_at FROM analytics.stg_notion_pages ORDER BY last_edited_at DESC LIMIT 10;"
        run_query "Notion: Pages by parent type & status" \
          "SELECT parent_type, is_archived, page_count, trashed_count FROM analytics.page_activity_summary ORDER BY page_count DESC;"
      fi
      ;;
    linear)
      if [ -n "${RAW_CREATED[linear_issues]:-}" ]; then
        run_query "Linear: Recent issues" \
          "SELECT identifier, title, state_name, priority_label, team_key, assignee_name FROM analytics.stg_linear_issues ORDER BY updated_at DESC LIMIT 10;"
        run_query "Linear: Issues by team & state" \
          "SELECT team_name, state_type, issue_count, total_estimate, avg_priority FROM analytics.issue_summary_by_team ORDER BY issue_count DESC LIMIT 10;"
      fi
      ;;
  esac
done

# ── Cross-integration queries ────────────────────────────────────────────────

if [ -n "${RAW_CREATED[github_repos]:-}" ] && [ -n "${RAW_CREATED[notion_pages]:-}" ]; then
  echo "── Cross-integration: GitHub + Notion ──"
  echo

  run_query "Workspace pulse: activity by week across tools" \
    "WITH combined AS (
      SELECT DATE_TRUNC('week', pushed_at::TIMESTAMP) AS week, 'github' AS source, repo_name AS item
      FROM analytics.stg_github_repos WHERE pushed_at IS NOT NULL
      UNION ALL
      SELECT DATE_TRUNC('week', last_edited_at::TIMESTAMP) AS week, 'notion' AS source, LEFT(page_id, 8) AS item
      FROM analytics.stg_notion_pages WHERE last_edited_at IS NOT NULL
    )
    SELECT week::DATE AS week, source, COUNT(*) AS items_active
    FROM combined
    WHERE week >= CURRENT_DATE - INTERVAL '12 weeks'
    GROUP BY week, source
    ORDER BY week DESC, source;"

  run_query "Team tool balance: GitHub repos vs Notion pages" \
    "SELECT
      (SELECT COUNT(*) FROM analytics.stg_github_repos WHERE NOT is_archived) AS active_repos,
      (SELECT COUNT(*) FROM analytics.stg_notion_pages WHERE NOT is_archived AND NOT is_trashed) AS active_pages,
      ROUND((SELECT COUNT(*) FROM analytics.stg_notion_pages WHERE NOT is_archived AND NOT is_trashed)::FLOAT
        / NULLIF((SELECT COUNT(*) FROM analytics.stg_github_repos WHERE NOT is_archived), 0), 1) AS pages_per_repo;"

  run_query "Stale audit: items not touched in 30+ days" \
    "WITH stale AS (
      SELECT 'github' AS source, repo_name AS item, pushed_at::TIMESTAMP AS last_active
      FROM analytics.stg_github_repos
      WHERE pushed_at::TIMESTAMP < CURRENT_DATE - INTERVAL '30 days' AND NOT is_archived
      UNION ALL
      SELECT 'notion' AS source, LEFT(page_id, 8) AS item, last_edited_at::TIMESTAMP AS last_active
      FROM analytics.stg_notion_pages
      WHERE last_edited_at::TIMESTAMP < CURRENT_DATE - INTERVAL '30 days' AND NOT is_archived AND NOT is_trashed
    )
    SELECT source, COUNT(*) AS stale_items, MIN(last_active)::DATE AS oldest_activity
    FROM stale GROUP BY source ORDER BY stale_items DESC;"
fi

if [ -n "${RAW_CREATED[slack_channels]:-}" ] && [ -n "${RAW_CREATED[linear_issues]:-}" ]; then
  echo "── Cross-integration: Slack + Linear ──"
  echo

  run_query "Team workload: Linear issues vs Slack channels per team" \
    "WITH issue_teams AS (
      SELECT team_name, COUNT(*) AS open_issues,
        SUM(CASE WHEN priority <= 2 THEN 1 ELSE 0 END) AS urgent_high
      FROM analytics.stg_linear_issues
      WHERE state_type IN ('started', 'unstarted', 'backlog')
      GROUP BY team_name
    ),
    team_channels AS (
      SELECT COUNT(*) AS active_channels, SUM(num_members) AS total_members
      FROM analytics.stg_slack_channels WHERE NOT is_archived
    )
    SELECT t.team_name, t.open_issues, t.urgent_high,
      c.active_channels, c.total_members
    FROM issue_teams t CROSS JOIN team_channels c
    ORDER BY t.open_issues DESC LIMIT 10;"

  run_query "Collaboration health: channel growth vs issue velocity" \
    "SELECT
      (SELECT COUNT(*) FROM analytics.stg_slack_channels WHERE NOT is_archived) AS active_channels,
      (SELECT ROUND(AVG(num_members), 1) FROM analytics.stg_slack_channels WHERE NOT is_archived) AS avg_members,
      (SELECT COUNT(*) FROM analytics.stg_linear_issues WHERE state_type = 'completed') AS completed_issues,
      (SELECT COUNT(*) FROM analytics.stg_linear_issues WHERE state_type = 'started') AS in_progress,
      (SELECT COUNT(*) FROM analytics.stg_linear_issues WHERE state_type IN ('started', 'unstarted', 'backlog')) AS total_open;"
fi

if [ -n "${RAW_CREATED[github_repos]:-}" ] && [ -n "${RAW_CREATED[notion_pages]:-}" ] && [ -n "${RAW_CREATED[linear_issues]:-}" ]; then
  echo "── Cross-integration: GitHub + Notion + Linear ──"
  echo

  run_query "Engineering rhythm: code vs docs vs tickets by week" \
    "WITH activity AS (
      SELECT DATE_TRUNC('week', pushed_at::TIMESTAMP)::DATE AS week,
        'code pushed' AS activity, repo_name AS item
      FROM analytics.stg_github_repos WHERE pushed_at IS NOT NULL
      UNION ALL
      SELECT DATE_TRUNC('week', last_edited_at::TIMESTAMP)::DATE AS week,
        'docs edited' AS activity, LEFT(page_id, 8) AS item
      FROM analytics.stg_notion_pages WHERE last_edited_at IS NOT NULL
      UNION ALL
      SELECT DATE_TRUNC('week', updated_at::TIMESTAMP)::DATE AS week,
        'issues moved' AS activity, identifier AS item
      FROM analytics.stg_linear_issues WHERE updated_at IS NOT NULL
    )
    SELECT week, activity, COUNT(*) AS items
    FROM activity
    WHERE week >= CURRENT_DATE - INTERVAL '8 weeks'
    GROUP BY week, activity
    ORDER BY week DESC, activity;"

  run_query "Repos with most open issues but no recent docs" \
    "WITH repo_issues AS (
      SELECT team_name, COUNT(*) AS open_issues
      FROM analytics.stg_linear_issues
      WHERE state_type IN ('started', 'unstarted')
      GROUP BY team_name
    ),
    recent_docs AS (
      SELECT COUNT(*) AS recent_pages
      FROM analytics.stg_notion_pages
      WHERE last_edited_at::TIMESTAMP >= CURRENT_DATE - INTERVAL '14 days'
        AND NOT is_archived AND NOT is_trashed
    )
    SELECT ri.team_name, ri.open_issues,
      rd.recent_pages AS docs_edited_last_2wk,
      CASE WHEN rd.recent_pages = 0 THEN 'needs docs'
           WHEN ri.open_issues > 20 THEN 'heavy load'
           ELSE 'healthy' END AS status
    FROM repo_issues ri CROSS JOIN recent_docs rd
    ORDER BY ri.open_issues DESC LIMIT 10;"

  run_query "Freshness scorecard: days since last activity per tool" \
    "SELECT
      'GitHub' AS tool,
      MAX(pushed_at::TIMESTAMP)::DATE AS last_activity,
      CURRENT_DATE - MAX(pushed_at::TIMESTAMP)::DATE AS days_ago
    FROM analytics.stg_github_repos WHERE pushed_at IS NOT NULL
    UNION ALL
    SELECT 'Notion',
      MAX(last_edited_at::TIMESTAMP)::DATE,
      CURRENT_DATE - MAX(last_edited_at::TIMESTAMP)::DATE
    FROM analytics.stg_notion_pages WHERE last_edited_at IS NOT NULL
    UNION ALL
    SELECT 'Linear',
      MAX(updated_at::TIMESTAMP)::DATE,
      CURRENT_DATE - MAX(updated_at::TIMESTAMP)::DATE
    FROM analytics.stg_linear_issues WHERE updated_at IS NOT NULL
    ORDER BY days_ago;"
fi

if [ ${#ACTIVE_INTEGRATIONS[@]} -ge 3 ]; then
  echo "── Cross-integration: full workspace overview ──"
  echo

  # Build inventory query dynamically from active integrations
  INVENTORY_SQL=""
  if [ -n "${RAW_CREATED[github_repos]:-}" ]; then
    INVENTORY_SQL+="SELECT 'GitHub repos' AS asset_type, COUNT(*) AS total, SUM(CASE WHEN NOT is_archived THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN is_archived THEN 1 ELSE 0 END) AS archived FROM analytics.stg_github_repos"
  fi
  if [ -n "${RAW_CREATED[notion_pages]:-}" ]; then
    [ -n "$INVENTORY_SQL" ] && INVENTORY_SQL+=" UNION ALL "
    INVENTORY_SQL+="SELECT 'Notion pages', COUNT(*), SUM(CASE WHEN NOT is_archived AND NOT is_trashed THEN 1 ELSE 0 END), SUM(CASE WHEN is_archived OR is_trashed THEN 1 ELSE 0 END) FROM analytics.stg_notion_pages"
  fi
  if [ -n "${RAW_CREATED[slack_channels]:-}" ]; then
    [ -n "$INVENTORY_SQL" ] && INVENTORY_SQL+=" UNION ALL "
    INVENTORY_SQL+="SELECT 'Slack channels', COUNT(*), SUM(CASE WHEN NOT is_archived THEN 1 ELSE 0 END), SUM(CASE WHEN is_archived THEN 1 ELSE 0 END) FROM analytics.stg_slack_channels"
  fi
  if [ -n "${RAW_CREATED[linear_issues]:-}" ]; then
    [ -n "$INVENTORY_SQL" ] && INVENTORY_SQL+=" UNION ALL "
    INVENTORY_SQL+="SELECT 'Linear issues', COUNT(*), SUM(CASE WHEN state_type IN ('started','unstarted','backlog') THEN 1 ELSE 0 END), SUM(CASE WHEN state_type IN ('completed','cancelled') THEN 1 ELSE 0 END) FROM analytics.stg_linear_issues"
  fi

  run_query "Workspace inventory: assets across all tools" \
    "${INVENTORY_SQL} ORDER BY total DESC;"
fi

# ── Summary ──────────────────────────────────────────────────────────────────

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Done!                                                     ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo
echo "Artifacts:"
echo "  Parquet:  $OUTPUT_DIR/"
echo "  SQL:      $COMPILED_DIR/"
echo "  DuckDB:   $DUCKDB_PATH"
echo
echo "Explore interactively:"
echo "  duckdb $DUCKDB_PATH"
