# learn-sandbox

Credential-free sandbox dataset for the `dogsled learn` tutorial. Teaches the extract, load, model, and query workflow using synthetic e-commerce data against a local DuckDB file.

## Tables

| Table      | Rows | Description                           |
| ---------- | ---- | ------------------------------------- |
| products   | 25   | Product catalog (5 categories)        |
| orders     | 60   | Customer orders (Nov 2025 – Apr 2026) |
| line_items | 90   | Order line items referencing products |

## Requirements

- Zero credentials required — uses a local DuckDB file (`learn.duckdb`).
- All data is synthetic and self-contained in `seeds/data/`.

## Quick start

```bash
# Load seed CSVs into DuckDB
dogsled model seed load --integration duckdb

# Query loaded data
dogsled load query --db-path ./learn.duckdb "SELECT * FROM products LIMIT 5"

# Validate and compile Model Spec models
dogsled model validate --integration duckdb
dogsled model compile stg_orders --integration duckdb

# Run all models (creates views and tables)
dogsled model run --integration duckdb

# Query the materialized fact table
dogsled load query --db-path ./learn.duckdb "SELECT * FROM fct_order_summary"
```

## Models

| Model             | Type  | Description                                      |
| ----------------- | ----- | ------------------------------------------------ |
| stg_orders        | VIEW  | Staging layer: typed and cleaned orders          |
| fct_order_summary | TABLE | Fact table: revenue per customer with item count |

## Used by

This workspace is used by `dogsled learn` (Phase 1 and Phase 4). Run the tutorial with:

```bash
dogsled learn --section "Phase 1"   # Credential-free extract & load
dogsled learn --section "Phase 4"   # Model Spec data modeling
```
