#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_PATH="$ROOT_DIR/first-ingest.duckdb"
DOC_PROTOCOL="$ROOT_DIR/first_pdf.protocol.jsonl"
PROTOCOL_SAMPLE="$ROOT_DIR/protocol-sample.jsonl"
GITHUB_PROTOCOL="$ROOT_DIR/public_repos.protocol.jsonl"

if [ -n "${DOGSLED_CLI:-}" ]; then
  # shellcheck disable=SC2206
  DOGSLED_CMD=(${DOGSLED_CLI})
elif [ -f "$ROOT_DIR/../../packages/bobsled-core/bin/cli.mjs" ]; then
  DOGSLED_CMD=(node "$ROOT_DIR/../../packages/bobsled-core/bin/cli.mjs")
elif command -v bobsled >/dev/null 2>&1; then
  DOGSLED_CMD=(bobsled)
else
  echo "Dogsled CLI not found. Run pnpm setup, install @bobsled-inc/bobsled-core, or set DOGSLED_CLI."
  exit 1
fi

run_query() {
  local title="$1"
  local sql="$2"

  echo
  echo "$title"
  DOGSLED_OUTPUT_FORMAT=text "${DOGSLED_CMD[@]}" query --db-path "$DB_PATH" "$sql"
}

cd "$ROOT_DIR"

echo "1. Validate first-ingest specs"
"${DOGSLED_CMD[@]}" extract validate

echo
echo "2. Remove generated demo artifacts"
rm -f "$DB_PATH" "$DB_PATH.wal" "$DOC_PROTOCOL" "$PROTOCOL_SAMPLE" "$GITHUB_PROTOCOL"
rm -rf "$ROOT_DIR/.extractor" "$ROOT_DIR/output" "$ROOT_DIR/batch"

echo
echo "3. Capture local document protocol sample"
"${DOGSLED_CMD[@]}" extract run --integration local_docs first_pdf >"$DOC_PROTOCOL"
awk '
  /"type":"SCHEMA"/ && schemas < 4 { print; schemas += 1; next }
  /"type":"RECORD"/ && records < 4 { print; records += 1; next }
  /"type":"STATE"/ && states < 1 { print; states += 1; next }
' "$DOC_PROTOCOL" >"$PROTOCOL_SAMPLE"
echo "Wrote $PROTOCOL_SAMPLE"
sed -n '1,12p' "$PROTOCOL_SAMPLE"

echo
echo "4. Load local PDF document streams into DuckDB"
"${DOGSLED_CMD[@]}" load run --dest duckdb --db-path "$DB_PATH" --target-schema main <"$DOC_PROTOCOL"

echo
echo "5. Extract public GitHub repos and load into the same DuckDB file"
"${DOGSLED_CMD[@]}" extract run --integration github_public public_repos --limit 5 >"$GITHUB_PROTOCOL"
"${DOGSLED_CMD[@]}" load run --dest duckdb --db-path "$DB_PATH" --target-schema main <"$GITHUB_PROTOCOL"

run_query \
  "6. first_pdf__documents" \
  "SELECT source_uri, parser_version, byte_length FROM first_pdf__documents LIMIT 5"

run_query \
  "7. first_pdf__chunks" \
  "SELECT chunk_id, chunk_index, token_count, text FROM first_pdf__chunks ORDER BY chunk_index LIMIT 5"

run_query \
  "8. first_pdf__parse_errors" \
  "SELECT source_uri, error_code, error_message FROM first_pdf__parse_errors LIMIT 5"

run_query \
  "9. first_pdf__acl" \
  "SELECT row_id, row_type, principal_id, source_grant_type, source_provider FROM first_pdf__acl LIMIT 5"

run_query \
  "10. public_repos" \
  "SELECT name, full_name, stargazers_count, updated_at FROM public_repos ORDER BY updated_at DESC LIMIT 5"

echo
echo "Done. DuckDB file: $DB_PATH"
