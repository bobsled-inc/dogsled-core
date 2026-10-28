#!/usr/bin/env bash

ARTIFACT_DIR="$PROJECT_DIR/review/artifacts"

step_header() {
  local step="$1"
  local title="$2"
  local explanation="$3"

  if [[ "$MODE" == "illustrative" ]]; then
    printf '\n== Step %s — %s ==\n%s\n' "$step" "$title" "$explanation"
  fi
}

pretty_print_json() {
  local file_path="$1"
  node --input-type=module - "$file_path" <<'EOF'
import { readFileSync } from 'node:fs';
const filePath = process.argv[2];
const data = JSON.parse(readFileSync(filePath, 'utf8'));

// Strip raw sql/query fields — they are noise in terminal output.
function clean(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(clean);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'sql' || k === 'query') continue;
    out[k] = clean(v);
  }
  return out;
}

const json = JSON.stringify(clean(data), null, 2);
console.log(json.replace(/\\n/g, '\n').replace(/\\t/g, '\t'));
EOF
}

data_header() {
  [[ "$MODE" == "illustrative" ]] && printf '\n── %s ──\n' "$1"
}

if ! declare -f run_model_json > /dev/null 2>&1; then
  run_model_json() {
    local output_path="$1"
    shift
    (
      cd "$PROJECT_DIR" || exit 1
      "$TSX_BIN" "$BMS_BIN" "$@" --json --quiet >"$output_path"
    )
  }
fi

if ! declare -f run_eg_json > /dev/null 2>&1; then
  run_eg_json() {
    local output_path="$1"
    shift
    (
      cd "$PROJECT_DIR" || exit 1
      node "$ENTITY_GRAPH_BIN" "$@" --json --quiet >"$output_path"
    )
  }
fi

run_runner_query_json() {
  local output_path="$1"
  local sql="$2"
  node --input-type=module - "$RUNNER" "$sql" "$output_path" <<'EOF'
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [runnerPath, sql, outputPath] = process.argv.slice(2);
const runner = await import(pathToFileURL(runnerPath).href);
if (typeof runner.query !== 'function') {
  throw new Error(`Runner ${runnerPath} does not implement query(sql).`);
}
const rows = await runner.query(sql);
const minSafeBigInt = BigInt(Number.MIN_SAFE_INTEGER);
const maxSafeBigInt = BigInt(Number.MAX_SAFE_INTEGER);
const normalized = JSON.parse(
  JSON.stringify(rows, (_key, value) => {
    if (typeof value === 'bigint') {
      return value >= minSafeBigInt && value <= maxSafeBigInt ? Number(value) : String(value);
    }
    return value;
  })
);
writeFileSync(outputPath, `${JSON.stringify(normalized, null, 2)}\n`);
EOF
}

show_result() {
  local file_path="$1"
  if [[ "$MODE" == "illustrative" ]]; then
    pretty_print_json "$file_path"
  fi
}

run_pipeline() {
  mkdir -p "$ARTIFACT_DIR"

  step_header "1" "Validate Specs" "Validate seeds, resolution, survivorship, and truthset assets before writing anything to the warehouse."
  run_model_json "$ARTIFACT_DIR/01-seed-validate.json" seed validate
  run_eg_json "$ARTIFACT_DIR/01-resolve-validate.json" resolve validate customer --dialect "$DIALECT"
  run_eg_json "$ARTIFACT_DIR/01-survivorship-validate.json" survivorship validate customer --dialect "$DIALECT"
  run_eg_json "$ARTIFACT_DIR/01-truthset-validate.json" truthset validate customer
  show_result "$ARTIFACT_DIR/01-seed-validate.json"
  show_result "$ARTIFACT_DIR/01-resolve-validate.json"
  show_result "$ARTIFACT_DIR/01-survivorship-validate.json"
  show_result "$ARTIFACT_DIR/01-truthset-validate.json"

  step_header "2" "Load Seed Data" "Create the raw source tables from committed CSV seeds so both DuckDB and BigQuery start from the same synthetic inputs."
  run_model_json "$ARTIFACT_DIR/02-seed-load.json" seed load --runner "$RUNNER" --dialect "$DIALECT"
  show_result "$ARTIFACT_DIR/02-seed-load.json"
  data_header "Raw table sample (3 rows per source)"
  run_runner_query_json "$ARTIFACT_DIR/02-raw-sample.json" \
    "SELECT * FROM (SELECT 'shopify' AS source, email, first_name, last_name, phone FROM raw.shopify_customers LIMIT 3) UNION ALL SELECT * FROM (SELECT 'hubspot', email, first_name, last_name, phone FROM raw.hubspot_contacts LIMIT 3) UNION ALL SELECT * FROM (SELECT 'zendesk', email, first_name, last_name, phone FROM raw.zendesk_users LIMIT 3) ORDER BY source"
  show_result "$ARTIFACT_DIR/02-raw-sample.json"

  step_header "3" "Run Resolution" "Build standardized rows, blocking pairs, scored pairs, and the review queue up through threshold routing."
  run_eg_json "$ARTIFACT_DIR/03-resolve-run.json" resolve run customer --runner "$RUNNER" --dialect "$DIALECT"
  show_result "$ARTIFACT_DIR/03-resolve-run.json"
  data_header "Standardized records — email cleaning applied (sample)"
  run_runner_query_json "$ARTIFACT_DIR/03-standardized-sample.json" \
    "SELECT _source_system AS source, email AS raw_email, standardized_email, standardized_first_name AS first_name, standardized_last_name AS last_name FROM entity_graph_test.customer__standardized ORDER BY source, standardized_email LIMIT 8"
  show_result "$ARTIFACT_DIR/03-standardized-sample.json"
  data_header "Pair scores — all candidate pairs ranked by match confidence"
  run_runner_query_json "$ARTIFACT_DIR/03-pair-scores.json" \
    "SELECT source_a, source_b, ROUND(CAST(composite_score AS DOUBLE), 3) AS score, match_type FROM entity_graph_test.customer__pair_scores ORDER BY score DESC"
  show_result "$ARTIFACT_DIR/03-pair-scores.json"
  data_header "Review queue — pairs routed to human/agent review"
  run_runner_query_json "$ARTIFACT_DIR/03-review-queue.json" \
    "SELECT threshold_band, ROUND(CAST(composite_score AS DOUBLE), 3) AS score, recommended_action, source_a, source_b FROM entity_graph_test.customer__review_queue ORDER BY score DESC"
  show_result "$ARTIFACT_DIR/03-review-queue.json"

  step_header "4" "Inspect Resolve Status" "Confirm that the early-stage runtime tables are populated before any review decisions are applied."
  run_eg_json "$ARTIFACT_DIR/04-resolve-status.json" resolve status customer --runner "$RUNNER" --dialect "$DIALECT"
  show_result "$ARTIFACT_DIR/04-resolve-status.json"

  step_header "5" "Agent Triage" "Ask the bounded agent workflow what the next action should be based on the live review queue and truthset posture."
  run_eg_json "$ARTIFACT_DIR/05-agent-triage.json" agent triage customer --runner "$RUNNER" --dialect "$DIALECT"
  show_result "$ARTIFACT_DIR/05-agent-triage.json"

  step_header "6" "Propose Agent Decisions" "Generate a review bundle for the agent-review band without mutating warehouse state yet."
  rm -f -- "$PROJECT_DIR/review/customer_agent_bundle.yml"
  run_eg_json "$ARTIFACT_DIR/06-review-batch-propose.json" agent review-batch --entity customer --runner "$RUNNER" --mode propose --output-bundle "$PROJECT_DIR/review/customer_agent_bundle.yml" --dialect "$DIALECT"
  [[ -s "$PROJECT_DIR/review/customer_agent_bundle.yml" ]] || {
    echo "review-batch did not write $PROJECT_DIR/review/customer_agent_bundle.yml" >&2
    exit 1
  }
  show_result "$ARTIFACT_DIR/06-review-batch-propose.json"

  step_header "7" "Apply Decisions And Cluster" "Apply the proposed review bundle, run clustering, then measure distinct clusters from the live warehouse."
  run_eg_json "$ARTIFACT_DIR/07-review-apply.json" review apply --input "$PROJECT_DIR/review/customer_agent_bundle.yml" --entity customer --runner "$RUNNER" --dialect "$DIALECT"
  run_eg_json "$ARTIFACT_DIR/07-resolve-cluster.json" resolve cluster customer --runner "$RUNNER" --dialect "$DIALECT"
  run_eg_json "$ARTIFACT_DIR/07-resolve-status-post-cluster.json" resolve status customer --runner "$RUNNER" --dialect "$DIALECT"
  run_runner_query_json "$ARTIFACT_DIR/07-cluster-summary.json" "SELECT COUNT(DISTINCT cluster_id) AS distinct_clusters, COUNT(*) AS clustered_records FROM entity_graph_test.customer__clusters"
  show_result "$ARTIFACT_DIR/07-review-apply.json"
  show_result "$ARTIFACT_DIR/07-resolve-cluster.json"
  show_result "$ARTIFACT_DIR/07-resolve-status-post-cluster.json"
  show_result "$ARTIFACT_DIR/07-cluster-summary.json"
  data_header "Clusters by source — records grouped after deduplication"
  run_runner_query_json "$ARTIFACT_DIR/07-cluster-sources.json" \
    "SELECT cluster_id, COUNT(*) AS records, COUNT(DISTINCT source_system) AS sources FROM entity_graph_test.customer__clusters GROUP BY cluster_id ORDER BY records DESC LIMIT 10"
  show_result "$ARTIFACT_DIR/07-cluster-sources.json"

  step_header "8" "Run Survivorship" "Refresh the golden-record outputs after clustering so each cluster has source-prioritized customer attributes."
  run_eg_json "$ARTIFACT_DIR/08-survivorship-refresh.json" agent survivorship-refresh customer --runner "$RUNNER" --dialect "$DIALECT"
  show_result "$ARTIFACT_DIR/08-survivorship-refresh.json"
  data_header "Golden record — one winning attribute value per entity (sample)"
  run_runner_query_json "$ARTIFACT_DIR/08-golden-record.json" \
    "SELECT entity_id, MAX(CASE WHEN attribute_name = 'email' THEN attribute_value END) AS email, MAX(CASE WHEN attribute_name = 'first_name' THEN attribute_value END) AS first_name, MAX(CASE WHEN attribute_name = 'last_name' THEN attribute_value END) AS last_name, MAX(CASE WHEN attribute_name = 'phone' THEN attribute_value END) AS phone FROM entity_graph_test.customer__golden_record GROUP BY entity_id ORDER BY entity_id LIMIT 10"
  show_result "$ARTIFACT_DIR/08-golden-record.json"

  step_header "9" "Regress Truthset" "Score the committed truthset labels against current pair scores so threshold quality stays measurable."
  run_eg_json "$ARTIFACT_DIR/09-truthset-regress.json" agent truthset-regress customer --runner "$RUNNER" --dialect "$DIALECT"
  show_result "$ARTIFACT_DIR/09-truthset-regress.json"

  if [[ "$MODE" == "test" ]]; then
    step_header "10" "Assert" "Enforce the integration-test expectations against the captured JSON artifacts."
    node --input-type=module - "$ARTIFACT_DIR" <<'EOF'
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const artifactDir = process.argv[2];
const loadJson = JSON.parse(readFileSync(join(artifactDir, '02-seed-load.json'), 'utf8'));
const proposeJson = JSON.parse(readFileSync(join(artifactDir, '06-review-batch-propose.json'), 'utf8'));
const applyJson = JSON.parse(readFileSync(join(artifactDir, '07-review-apply.json'), 'utf8'));
const clusterSummary = JSON.parse(readFileSync(join(artifactDir, '07-cluster-summary.json'), 'utf8'));
const survivorshipJson = JSON.parse(readFileSync(join(artifactDir, '08-survivorship-refresh.json'), 'utf8'));
const truthsetJson = JSON.parse(readFileSync(join(artifactDir, '09-truthset-regress.json'), 'utf8'));

const loadedRows = new Map(loadJson.seeds.map((seed) => [seed.name, seed.rows_loaded]));
if (loadedRows.get('shopify_customers') !== 18) {
  throw new Error(`Expected 18 Shopify rows, received ${loadedRows.get('shopify_customers')}.`);
}
if (loadedRows.get('hubspot_contacts') !== 14) {
  throw new Error(`Expected 14 HubSpot rows, received ${loadedRows.get('hubspot_contacts')}.`);
}
if (loadedRows.get('zendesk_users') !== 11) {
  throw new Error(`Expected 11 Zendesk rows, received ${loadedRows.get('zendesk_users')}.`);
}

const decisionCount = proposeJson.summary?.decision_count ?? 0;
if (decisionCount <= 0) {
  throw new Error('Expected agent review-batch propose to emit at least one decision.');
}

const appliedCount = applyJson.applied_count ?? applyJson.summary?.applied_count ?? 0;
if (appliedCount <= 0) {
  throw new Error('Expected review apply to write at least one decision.');
}

const distinctClusters = Number(clusterSummary[0]?.distinct_clusters ?? 0);
if (!Number.isFinite(distinctClusters) || distinctClusters <= 0) {
  throw new Error(`Expected a positive distinct cluster count, received ${distinctClusters}.`);
}
if (distinctClusters >= 43) {
  throw new Error(`Expected deduplication to reduce 43 source records, received ${distinctClusters} clusters.`);
}

const survivorshipEntity = survivorshipJson.summary?.entities?.[0];
const goldenRows = Number(survivorshipEntity?.summary?.golden_record ?? 0);
if (!Number.isFinite(goldenRows) || goldenRows <= 0) {
  throw new Error(`Expected survivorship to materialize golden-record rows, received ${goldenRows}.`);
}

const truthsetEntity = truthsetJson.summary?.entities?.[0];
const requiredPrecision = Number(truthsetEntity?.required_precision ?? 0);
const precision = Number(truthsetEntity?.current_metrics?.auto_merge_precision ?? 0);
if (!Number.isFinite(requiredPrecision)) {
  throw new Error(`Expected truthset required precision to be finite, received ${requiredPrecision}.`);
}
if (!Number.isFinite(precision) || precision < requiredPrecision) {
  throw new Error(
    `Expected truthset auto-merge precision >= ${requiredPrecision}, received ${precision}.`
  );
}

console.log(JSON.stringify({
  status: 'ok',
  loaded_rows: Object.fromEntries(loadedRows),
  decision_count: decisionCount,
  applied_count: appliedCount,
  distinct_clusters: distinctClusters,
  golden_record_rows: goldenRows,
  auto_merge_precision: precision,
  required_precision: requiredPrecision
}, null, 2));
EOF
  fi
}
