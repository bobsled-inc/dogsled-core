#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -n "${BOBSLED_CORE_CLI:-}" ]; then
  # shellcheck disable=SC2206
  BOBSLED_CORE_CMD=(${BOBSLED_CORE_CLI})
elif [ -f "$ROOT_DIR/../../packages/bobsled-core/bin/cli.mjs" ]; then
  BOBSLED_CORE_CMD=(node "$ROOT_DIR/../../packages/bobsled-core/bin/cli.mjs")
elif command -v bobsled >/dev/null 2>&1; then
  BOBSLED_CORE_CMD=(bobsled)
else
  echo "Dogsled CLI not found. Run pnpm setup, install @bobsled-inc/bobsled-core, or set BOBSLED_CORE_CLI."
  exit 1
fi

cd "$ROOT_DIR"
rm -rf generated .smoke-receipt.json .tmp

echo "1. Validate entity graph specs"
"${BOBSLED_CORE_CMD[@]}" entity-graph resolve validate Customer Deal Document --yaml

echo
echo "2. Extract document mentions with credential-free fallback"
"${BOBSLED_CORE_CMD[@]}" entity-graph mentions extract Customer --runner ./runner.js --fallback compromise --yaml

echo
echo "3. Extract and compact document-derived relationships"
"${BOBSLED_CORE_CMD[@]}" entity-graph relationships extract Customer --runner ./runner.js --fallback compromise --yaml
"${BOBSLED_CORE_CMD[@]}" entity-graph relationships compact --runner ./runner.js --schema entity_graph --yaml >/dev/null

echo
echo "4. Generate the local TypeScript SDK"
mkdir -p .tmp
SDK_RECEIPT="$("${BOBSLED_CORE_CMD[@]}" sdk generate --lang ts --out ./generated/dogsled-sdk --json)"
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
