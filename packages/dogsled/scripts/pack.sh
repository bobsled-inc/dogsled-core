#!/usr/bin/env bash
set -euo pipefail

# Builds dogsled and its delegated CLIs, stages only the public runtime artifacts
# needed to execute them and creates a distributable zip in the output directory.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOGSLED_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DOGSLED_DIR/../.." && pwd)"

VERSION="$(node -p "require('$DOGSLED_DIR/package.json').version")"
ZIP_NAME="dogsled-v${VERSION}.zip"
STAGING_DIR=$(mktemp -d -t dogsled-pack.XXXXXX)
trap 'rm -rf "$STAGING_DIR"' EXIT
OUTPUT_DIR="${1:?Usage: pack.sh <output-directory>}"
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
DEPLOY_DIR="$STAGING_DIR/deploy"
PACKAGE_DIR="$STAGING_DIR/dogsled"

copy_package_dist() {
  local package_name="$1"
  local source_dir="$2"
  local destination_dir="$PACKAGE_DIR/node_modules/@bobsled-inc/$package_name"

  mkdir -p "$destination_dir"
  cp -R "$source_dir/dist" "$destination_dir/"
}

# Copy a single npm package (and its transitive deps) into the staging area.
# Handles scoped packages by creating parent directories as needed.
#
# $1: dependency name to install
# $2: directory to resolve from (defaults to REPO_ROOT). Resolving from the
#     consuming package's directory ensures we pick up deps that only exist in
#     the consuming package's node_modules (important for pnpm's isolated
#     layout where hoisting is not guaranteed).
install_dep() {
  local dep="$1"
  local resolve_from="${2:-$REPO_ROOT}"
  # Skip if already present
  if [ -d "$PACKAGE_DIR/node_modules/$dep" ]; then
    return
  fi

  local resolved
  resolved=$(DEP_NAME="$dep" RESOLVE_FROM="$resolve_from" node -e "
    const fs = require('node:fs');
    const { createRequire } = require('node:module');
    try {
      const req = createRequire(process.env.RESOLVE_FROM + '/package.json');
      const p = req.resolve(process.env.DEP_NAME + '/package.json').replace('/package.json','');
      console.log(fs.realpathSync(p));
    } catch {
      process.exit(1);
    }
  " 2>/dev/null) || {
    echo "✗ Failed to resolve runtime dependency: $dep (from $resolve_from)" >&2
    exit 1
  }

  # Create parent dir for scoped packages (e.g., @apidevtools/)
  mkdir -p "$(dirname "$PACKAGE_DIR/node_modules/$dep")"
  cp -R "$resolved" "$PACKAGE_DIR/node_modules/$dep"

  # Recursively install sub-deps, resolving from the package we just copied.
  local sub_deps
  sub_deps=$(RESOLVED_PKG="$resolved" node -e "
    const pkg = require(process.env.RESOLVED_PKG + '/package.json');
    for (const d of Object.keys(pkg.dependencies || {})) console.log(d);
  " 2>/dev/null) || true
  for sub_dep in $sub_deps; do
    install_dep "$sub_dep" "$resolved"
  done
}

# Workspace packages that are explicitly staged via copy_package_dist below.
# copy_runtime_deps uses this as an allowlist of "already staged" deps to skip.
# Using an explicit list (rather than a `@bobsled-inc/` prefix filter) means
# any new internal package that isn't staged here will be treated as a normal
# runtime dependency and copied into the zip, so the bundle can never silently
# drop an internal dep.
BUNDLED_WORKSPACE_DEPS='["@bobsled-inc/protocol","@bobsled-inc/extractor","@bobsled-inc/loader","@bobsled-inc/model-spec","@bobsled-inc/entity-graph"]'

# Copy runtime dependencies for a delegated CLI package into the staging area.
# Reads the package's dependencies from package.json, skips workspace deps
# already staged via copy_package_dist (see BUNDLED_WORKSPACE_DEPS above), and
# copies each of the remaining runtime deps from the monorepo node_modules.
copy_runtime_deps() {
  local source_dir="$1"
  local deps
  deps=$(SOURCE_DIR="$source_dir" BUNDLED_DEPS="$BUNDLED_WORKSPACE_DEPS" node -e "
    const pkg = require(process.env.SOURCE_DIR + '/package.json');
    const bundled = new Set(JSON.parse(process.env.BUNDLED_DEPS));
    for (const dep of Object.keys(pkg.dependencies || {})) {
      if (!bundled.has(dep)) console.log(dep);
    }
  ")

  for dep in $deps; do
    install_dep "$dep" "$source_dir"
  done
}

write_package_manifest() {
  local package_name="$1"
  local destination_dir="$PACKAGE_DIR/node_modules/@bobsled-inc/$package_name"
  local manifest_path="$destination_dir/package.json"
  local exports_json="$2"

  PACKAGE_NAME="$package_name" \
  VERSION="$VERSION" \
  EXPORTS_JSON="$exports_json" \
  MANIFEST_PATH="$manifest_path" \
    node <<'EOF'
const fs = require('node:fs');

const manifest = {
  name: `@bobsled-inc/${process.env.PACKAGE_NAME}`,
  version: process.env.VERSION,
  private: false,
  type: 'module',
  exports: JSON.parse(process.env.EXPORTS_JSON),
};

fs.writeFileSync(process.env.MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
EOF
}

echo "▸ Building delegated CLIs…"
cd "$REPO_ROOT"
pnpm --filter @bobsled-inc/protocol build
pnpm --filter @bobsled-inc/extractor build
pnpm --filter @bobsled-inc/loader build
pnpm --filter @bobsled-inc/model-spec build
pnpm --filter @bobsled-inc/entity-graph build
pnpm --filter @bobsled-inc/dogsled build

echo "▸ Preparing staging directory…"
mkdir -p "$PACKAGE_DIR"

echo "▸ Installing runtime dependencies…"
pnpm --config.inject-workspace-packages=true deploy --filter @bobsled-inc/dogsled --prod "$DEPLOY_DIR"

echo "▸ Staging curated runtime package…"
cp -R "$DEPLOY_DIR/node_modules" "$PACKAGE_DIR/"
cp -R "$DOGSLED_DIR/dist" "$PACKAGE_DIR/"
cp "$SCRIPT_DIR/launcher.sh" "$PACKAGE_DIR/dogsled"
cp "$SCRIPT_DIR/install.sh" "$PACKAGE_DIR/install.sh"
chmod +x "$PACKAGE_DIR/dogsled" "$PACKAGE_DIR/install.sh"

mkdir -p "$PACKAGE_DIR/node_modules/@bobsled-inc"
# pnpm deploy stages @bobsled-inc/dogsled into node_modules, but we copy its
# dist/ separately to the top-level $PACKAGE_DIR/dist/ above. Remove the
# duplicate so the zip is not ~500 KB larger than necessary.
rm -rf "$PACKAGE_DIR/node_modules/@bobsled-inc/dogsled"

copy_package_dist "extractor" "$REPO_ROOT/packages/extractor"
copy_runtime_deps "$REPO_ROOT/packages/extractor"
write_package_manifest \
  "extractor" \
  '{".":{"import":"./dist/runtime/index.js"},"./core":{"import":"./dist/core/index.js"},"./runtime":{"import":"./dist/framework-runtime/index.js"},"./extractor":{"import":"./dist/extractor/index.js"}}'

copy_package_dist "loader" "$REPO_ROOT/packages/loader"
copy_runtime_deps "$REPO_ROOT/packages/loader"
# Bundle optional peer deps for BigQuery and GCS support
install_dep "@google-cloud/bigquery"
install_dep "@google-cloud/storage"
write_package_manifest \
  "loader" \
  '{".":{"import":"./dist/runtime/index.js"}}'

copy_package_dist "model-spec" "$REPO_ROOT/packages/model-spec"
write_package_manifest \
  "model-spec" \
  '{".":{"import":"./dist/compiler/index.js"},"./shared":{"import":"./dist/shared.js"}}'

copy_package_dist "entity-graph" "$REPO_ROOT/packages/entity-graph"
copy_runtime_deps "$REPO_ROOT/packages/entity-graph"
write_package_manifest \
  "entity-graph" \
  '{".":{"import":"./dist/index.js"}}'

copy_package_dist "protocol" "$REPO_ROOT/packages/protocol"
write_package_manifest "protocol" '{".":{"import":"./dist/index.js"}}'

# extractor-framework has been merged into @bobsled-inc/extractor (src/framework/)

echo "▸ Ensuring duckdb native binding…"
# DuckDB requires a platform-specific .node binary that node-pre-gyp downloads
# during install. Ensure it's present in the staged node_modules.
DUCKDB_PKG=$(find "$PACKAGE_DIR/node_modules" -path "*/duckdb/lib/duckdb-binding.js" -print -quit 2>/dev/null)
if [ -n "$DUCKDB_PKG" ]; then
  DUCKDB_LIB_DIR="$(dirname "$DUCKDB_PKG")"
  if [ ! -f "$DUCKDB_LIB_DIR/binding/duckdb.node" ]; then
    # Find the binding from the monorepo install
    REPO_DUCKDB_BINDING=$(find "$REPO_ROOT/node_modules" -path "*/duckdb/lib/binding/duckdb.node" -print -quit 2>/dev/null)
    if [ -n "$REPO_DUCKDB_BINDING" ]; then
      mkdir -p "$DUCKDB_LIB_DIR/binding"
      cp "$REPO_DUCKDB_BINDING" "$DUCKDB_LIB_DIR/binding/duckdb.node"
      echo "  Copied duckdb.node binding"
    else
      if [ "${NO_DUCKDB:-}" = "1" ] || [ -n "${CI:-}" ]; then
        echo "  ⚠ duckdb.node not found (skipped — will be installed by install.sh at runtime)"
      else
        echo "  ✗ duckdb.node not found — run: cd node_modules/.pnpm/duckdb@*/node_modules/duckdb && npx node-pre-gyp install" >&2
        echo "  Set NO_DUCKDB=1 to skip this check in CI environments that don't need DuckDB." >&2
        exit 1
      fi
    fi
  else
    echo "  duckdb.node binding already present"
  fi
fi

echo "▸ Staging bundled examples…"
cp -R "$DOGSLED_DIR/examples" "$PACKAGE_DIR/examples"

echo "▸ Staging bundled integrations…"
INTEGRATIONS_SRC="${REPO_ROOT}/packages/integrations/integrations"
INTEGRATIONS_DIR="$PACKAGE_DIR/integrations"
mkdir -p "$INTEGRATIONS_DIR/integrations" "$INTEGRATIONS_DIR/resources"
for integration_dir in "$INTEGRATIONS_SRC"/*/; do
  integration_name="$(basename "$integration_dir")"
  [ "$integration_name" = "_template" ] && continue
  [ -f "$integration_dir/integration.yml" ] || continue
  cp "$integration_dir/integration.yml" "$INTEGRATIONS_DIR/integrations/${integration_name}.yml"
  if [ -d "$integration_dir/resources" ]; then
    mkdir -p "$INTEGRATIONS_DIR/resources/${integration_name}"
    cp "$integration_dir/resources/"*.yml "$INTEGRATIONS_DIR/resources/${integration_name}/"
  fi
done

cat > "$PACKAGE_DIR/extractor.yml" <<'EYML'
integrations_dir: integrations/integrations
resources_dir: integrations/resources
EYML

echo "▸ Creating zip…"
cd "$STAGING_DIR"
zip -yrq "$ZIP_NAME" dogsled

echo "▸ Generating SHA-256 checksum…"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$STAGING_DIR/$ZIP_NAME" | awk '{print $1}' > "$STAGING_DIR/$ZIP_NAME.sha256"
else
  shasum -a 256 "$STAGING_DIR/$ZIP_NAME" | awk '{print $1}' > "$STAGING_DIR/$ZIP_NAME.sha256"
fi

echo "▸ Verifying packed artifact…"
VERIFY_DIR=$(mktemp -d -t dogsled-verify.XXXXXX)
trap 'rm -rf "$STAGING_DIR" "$VERIFY_DIR"' EXIT

cd "$VERIFY_DIR"
unzip -q "$STAGING_DIR/$ZIP_NAME"

# 1. CLI runs
node dogsled/dist/index.js --help > /dev/null
echo "  ✓ dogsled --help works"

# 2. Validate bundled examples
(cd dogsled/examples/demo && node "$VERIFY_DIR/dogsled/dist/index.js" extract validate > /dev/null)
echo "  ✓ dogsled extract validate works"

# 3. DuckDB binding present (warn-only — binding is platform-specific and
#    installed by install.sh on the user's machine)
if ! find dogsled/node_modules -name "duckdb.node" -print -quit | grep -q .; then
  echo "  ⚠ duckdb.node not bundled (will be installed by install.sh)"
else
  echo "  ✓ duckdb.node present"
fi

# 4. Model validate works
(cd dogsled/examples/demo && node "$VERIFY_DIR/dogsled/dist/index.js" model validate > /dev/null)
echo "  ✓ dogsled model validate works"

# 5. Loader delegation resolves. `load --help` is the cheapest subcommand
# that loads the loader CLI subprocess end-to-end; a broken @bobsled-inc/loader
# staging path would fail here even if the rest of the zip is fine.
node "$VERIFY_DIR/dogsled/dist/index.js" load --help > /dev/null
echo "  ✓ dogsled load --help works"

# 6. Entity graph delegation resolves. `entity-graph --help` should load the staged
# @bobsled-inc/entity-graph CLI and its shared model-spec helpers successfully.
node "$VERIFY_DIR/dogsled/dist/index.js" entity-graph --help > /dev/null
echo "  ✓ dogsled entity-graph --help works"

cd "$STAGING_DIR"

echo "▸ Copying zip to $OUTPUT_DIR/…"
cp "$STAGING_DIR/$ZIP_NAME" "$OUTPUT_DIR/$ZIP_NAME"
cp "$STAGING_DIR/$ZIP_NAME.sha256" "$OUTPUT_DIR/$ZIP_NAME.sha256"

echo "✓ Packed $ZIP_NAME → $OUTPUT_DIR/$ZIP_NAME"
echo "✓ Checksum → $OUTPUT_DIR/$ZIP_NAME.sha256"
