#!/usr/bin/env bash

teardown_state() {
  : "${PROJECT_DIR:?PROJECT_DIR must be set}"
  : "${DIALECT:?DIALECT must be set}"
  : "${SCRIPT_DIR:?SCRIPT_DIR must be set}"
  if [[ -z "$PROJECT_DIR" || "$PROJECT_DIR" == "/" || "$PROJECT_DIR" == "." ]]; then
    echo "Refusing teardown with unsafe PROJECT_DIR=$PROJECT_DIR" >&2
    return 1
  fi
  if [[ ! -d "$PROJECT_DIR/entity-graph" || ! -f "$PROJECT_DIR/model-spec.yml" ]]; then
    echo "Refusing teardown outside customer-resolution project: $PROJECT_DIR" >&2
    return 1
  fi

  rm -rf -- "$PROJECT_DIR/review"

  case "$DIALECT" in
    duckdb)
      rm -f -- "$PROJECT_DIR/customer_resolution.db"
      ;;
    bigquery)
      node "$SCRIPT_DIR/bq-teardown.mjs"
      ;;
    *)
      echo "Unsupported DIALECT: $DIALECT" >&2
      return 1
      ;;
  esac
}
