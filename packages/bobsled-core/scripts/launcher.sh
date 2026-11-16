#!/usr/bin/env bash
set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
SYMLINK_DEPTH=0
while [ -L "$SOURCE" ]; do
  SYMLINK_DEPTH=$((SYMLINK_DEPTH + 1))
  if [ "$SYMLINK_DEPTH" -gt 10 ]; then
    echo "Error: Too many symlink levels resolving bobsled launcher" >&2
    exit 1
  fi
  SOURCE_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
  TARGET="$(readlink "$SOURCE")"
  if [[ "$TARGET" != /* ]]; then
    SOURCE="$SOURCE_DIR/$TARGET"
  else
    SOURCE="$TARGET"
  fi
done

SCRIPT_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"

ENTRYPOINT="$SCRIPT_DIR/dist/index.js"
if [ ! -f "$ENTRYPOINT" ]; then
  ENTRYPOINT="$SCRIPT_DIR/app/dist/index.js"
fi

exec node "$ENTRYPOINT" "$@"
