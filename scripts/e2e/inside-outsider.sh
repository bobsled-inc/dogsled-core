#!/bin/sh
set -eu
node /suite/scripts/e2e/run.mjs "$@"
if [ "$#" -eq 0 ]; then node /suite/scripts/e2e/outsider-packaging.mjs runtime; fi
