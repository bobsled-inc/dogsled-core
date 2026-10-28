#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -n "${DOGSLED_CLI:-}" ]; then
  # shellcheck disable=SC2206
  DOGSLED_CMD=(${DOGSLED_CLI})
elif [ -f "$ROOT_DIR/../../packages/dogsled/bin/cli.mjs" ]; then
  DOGSLED_CMD=(node "$ROOT_DIR/../../packages/dogsled/bin/cli.mjs")
elif command -v dogsled >/dev/null 2>&1; then
  DOGSLED_CMD=(dogsled)
else
  echo "Dogsled CLI not found. Run pnpm setup, install @bobsled-inc/dogsled, or set DOGSLED_CLI."
  exit 1
fi

cd "$ROOT_DIR"
rm -rf generated .smoke-receipt.json .tmp

echo "1. Validate entity graph specs"
"${DOGSLED_CMD[@]}" entity-graph resolve validate Customer Deal Document --yaml

echo
echo "2. Extract document mentions with credential-free fallback"
"${DOGSLED_CMD[@]}" entity-graph mentions extract Customer --runner ./runner.js --fallback compromise --yaml

echo
echo "3. Extract and compact document-derived relationships"
"${DOGSLED_CMD[@]}" entity-graph relationships extract Customer --runner ./runner.js --fallback compromise --yaml
"${DOGSLED_CMD[@]}" entity-graph relationships compact --runner ./runner.js --schema entity_graph --yaml >/dev/null

echo
echo "4. Generate the local TypeScript SDK"
mkdir -p .tmp
SDK_RECEIPT="$("${DOGSLED_CMD[@]}" sdk generate --lang ts --out ./generated/dogsled-sdk --json)"
printf '%s\n' "$SDK_RECEIPT" >.tmp/sdk-generate.json

echo
echo "5. Verify typed SDK query returns seeded data"
pnpm exec tsx src/verify.ts

node <<'NODE'
const fs = require('node:fs');
const sdk = JSON.parse(fs.readFileSync('.tmp/sdk-generate.json', 'utf8'));
const receipt = {
  ok: sdk.ok === true,
  example: 'entity-resolution-sdk',
  entity_count: sdk.entity_count,
  files_written: sdk.files_written,
};
fs.writeFileSync('.smoke-receipt.json', JSON.stringify(receipt, null, 2) + '\n');
NODE

echo "Done. Generated SDK: $ROOT_DIR/generated/dogsled-sdk"
