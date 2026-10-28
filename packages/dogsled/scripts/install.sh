#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "${HOME:-}" ] && [ -z "${DOGSLED_INSTALL_ROOT:-}" ]; then
  echo "Error: HOME is not set and DOGSLED_INSTALL_ROOT is not specified." >&2
  exit 1
fi
INSTALL_ROOT="${DOGSLED_INSTALL_ROOT:-$HOME/.dogsled}"
INSTALL_DIR="${DOGSLED_INSTALL_DIR:-$INSTALL_ROOT/bin}"
APP_DIR="$INSTALL_ROOT/dogsled"
BINARY="dogsled"

# Guard against dangerous install roots that could cause data loss via rm -rf.
RESOLVED_ROOT="$(cd "$INSTALL_ROOT" 2>/dev/null && pwd -P || echo "$INSTALL_ROOT")"
case "$RESOLVED_ROOT" in
  /|/etc|/usr|/var|/tmp|/bin|/sbin|/lib|/opt|/System)
    echo "Error: DOGSLED_INSTALL_ROOT points to a system directory: $INSTALL_ROOT" >&2
    exit 1
    ;;
esac

ensure_duckdb_binding() {
  APP_DIR_ENV="$APP_DIR" node <<'EOF'
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const appDir = process.env.APP_DIR_ENV;
const appEntrypoint = path.join(appDir, 'dist', 'index.js');
const requireFromApp = createRequire(pathToFileURL(appEntrypoint));

let duckdbPackageJson;
try {
  duckdbPackageJson = requireFromApp.resolve('duckdb/package.json');
} catch {
  process.exit(0);
}

const duckdbDir = path.dirname(duckdbPackageJson);
const bindingPath = path.join(duckdbDir, 'lib', 'binding', 'duckdb.node');
if (fs.existsSync(bindingPath)) {
  process.exit(0);
}

const preGypBin = path.join(
  duckdbDir,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'node-pre-gyp.cmd' : 'node-pre-gyp'
);

if (!fs.existsSync(preGypBin)) {
  console.error('Error: DuckDB installer not found in the dogsled package.');
  process.exit(1);
}

console.log('Installing DuckDB native runtime...');

const env = {
  ...process.env,
  PATH: `${path.dirname(preGypBin)}${path.delimiter}${process.env.PATH ?? ''}`,
};

const result = spawnSync(preGypBin, ['install', '--fallback-to-build'], {
  cwd: duckdbDir,
  env,
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if ((result.status ?? 1) !== 0) {
  process.exit(result.status ?? 1);
}

if (!fs.existsSync(bindingPath)) {
  console.error('Error: DuckDB native runtime install completed without producing duckdb.node.');
  process.exit(1);
}
EOF
}

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required but not found. Install Node.js 20+ first." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')" || { echo "Error: Node.js version check failed" >&2; exit 1; }
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Error: Node.js 20+ is required (found v$(node -p process.version))." >&2
  exit 1
fi

if [ ! -f "$SCRIPT_DIR/$BINARY" ] || [ ! -d "$SCRIPT_DIR/dist" ] || [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  echo "Error: dogsled package contents not found in $SCRIPT_DIR. Re-extract the zip and try again." >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
mkdir -p "$(dirname "$APP_DIR")"
# Validate APP_DIR is under INSTALL_ROOT before removing
RESOLVED_APP="$(cd "$(dirname "$APP_DIR")" && pwd -P)/$(basename "$APP_DIR")"
case "$RESOLVED_APP" in
  "$RESOLVED_ROOT"/*)
    ;;
  *)
    echo "Error: APP_DIR ($APP_DIR) resolves outside INSTALL_ROOT ($INSTALL_ROOT)" >&2
    exit 1
    ;;
esac
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR"
cp -R "$SCRIPT_DIR/." "$APP_DIR/"
chmod +x "$APP_DIR/$BINARY"
ensure_duckdb_binding
ln -sf "$APP_DIR/$BINARY" "$INSTALL_DIR/$BINARY"

echo "Installed dogsled to $INSTALL_DIR/$BINARY"

if ! echo "$PATH" | tr ':' '\n' | grep -Fqx "$INSTALL_DIR"; then
  SHELL_NAME="$(basename "${SHELL:-/bin/bash}")"
  case "$SHELL_NAME" in
    zsh)  RC_FILE=".zshrc" ;;
    bash) RC_FILE=".bashrc" ;;
    *)    RC_FILE=".profile" ;;
  esac

  echo ""
  echo "Add dogsled to your PATH by running:"
  echo ""
  echo "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/$RC_FILE && source ~/$RC_FILE"
  echo ""
fi
