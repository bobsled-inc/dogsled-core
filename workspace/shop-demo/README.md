# Shop Demo

A compact end-to-end Model Spec reference project for Bobsled Core: five seed CSVs, source declarations, staging models with cleaning expressions, expectation contracts, mart models, semantic metadata, metrics, relationships, and verified queries.

The domain is a small e-commerce shop. Raw customer, product, order, item, and payment exports are loaded into DuckDB. Staging models clean the data using Model Spec column expressions (`collapse_whitespace`, `strip_legal_suffixes`, `digits_only`, `strip_www`) and rebuild it into `fct_orders` and `dim_customers` tables.

The raw data intentionally includes mixed-case emails, legal company suffixes, full website URLs, country-coded phone numbers, and inconsistent product categories — so the cleaning layer has visible work to do.

## Run It

```bash
# 1. Seed and materialise all models
pnpm exec tsx rebuild-demo.ts

# 2. Validate contracts against the live DB
bobsled model validate --integration duckdb

# 3. Compile a model to inspect the generated SQL
bobsled model compile stg_customers --integration duckdb

# 4. Run expectations for a model
bobsled model expect run --model stg_customers --integration duckdb --runner ./runner.duckdb.js
```

## Layer map

| Layer            | Files                                               | Purpose                                         |
| ---------------- | --------------------------------------------------- | ----------------------------------------------- |
| Seeds            | `seeds/data/*.csv`                                  | Raw source data loaded with replace-on-conflict |
| Sources          | `sources/demo/`                                     | Source declarations mapping raw tables          |
| Staging          | `models/stg_*.yml`                                  | Cleaning, typing, expectation contracts         |
| Marts            | `models/fct_orders.yml`, `models/dim_customers.yml` | Analytics-ready joins and aggregations          |
| Metrics          | `metrics/*.yml`                                     | Semantic metric definitions                     |
| Relationships    | `relationships/*.yml`                               | Foreign-key graph for agent traversal           |
| Verified queries | `vqs/*.yml`                                         | Pre-approved SQL for reliable agent answers     |
