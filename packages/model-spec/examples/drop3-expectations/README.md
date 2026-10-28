# Drop 3 Expectations Example

Minimal Model Spec project showing canonical field metadata, fuzzy-ready transform expressions, and
`expect:` blocks.

```bash
pnpm --filter @bobsled-inc/model-spec build
node ../../dist/index.js validate --integration duckdb --semantic-check
node ../../dist/index.js expect run --model stg_customers --integration duckdb
```
