---
name: model-profiler
description: Profile Dogsled/Model Spec warehouse sources or models with confidence-scored inferences and cleaning suggestions. Use when an agent needs to run or interpret `dogsled model profile`, propose cleaning/model metadata, inspect PK/FK candidates, or prepare entity graph onboarding evidence from sampled data.
---

# Model Profiler

Use this skill when profiling warehouse data, interpreting profiler output, or using profiler evidence to author Model Spec/entity graph specs.

## References

- Quick start: `packages/model-spec/docs/profiler-quickstart.md`
- User guide: `packages/model-spec/docs/profiler-user-guide.md`
- Implementation: `packages/model-spec/src/commands/profile.ts` and `packages/model-spec/src/profiler/`

Load the user guide when you need output-field details, limitations, or runner requirements.

## Default Workflow

1. Validate the project:

   ```bash
   dogsled model validate --integration <handle>
   ```

2. Profile the source or model with JSON output:

   ```bash
   dogsled model profile <source_or_model> --integration <handle> --json --quiet
   ```

3. For cleaning-only onboarding:

   ```bash
   dogsled model profile suggest cleaning <source_or_model> \
     --integration <handle> \
     --confidence-min 0.8 \
     --json \
     --quiet
   ```

4. Use `--runner ./runner.js` only when the project cannot construct a built-in integration runner or when a test/demo needs mocked SQL results.

5. Preserve profiler evidence when changing specs:
   - map strong `pkCandidates` to `primary_key` or model `grain`
   - map target-backed `fkCandidates` to `references`
   - map high-confidence cleaning suggestions to reviewed model expressions or entity graph rules
   - do not apply cleaning automatically

## Interpreting Cleaning Suggestions

Each `cleaningSuggestions` entry includes a `model_expr` field:

- **Non-null**: a ready-to-use Model Spec column expression (e.g. `collapse_whitespace(lower(strip_legal_suffixes(company_name)))`). Copy it verbatim into a model `columns[].expr` or cite it in the PR summary as profiler evidence.
- **`null`**: the transform set has no direct SQL mapping (`normalize_state` is the common case — it needs a 51-entry state lookup). Skip it, hand-author a `raw_sql()` expression, or copy the `transforms` list into an entity graph `standardize` block as-is.

**Detection trigger summary** (load the user guide for the full table):

- `trim` / `collapse_whitespace` — any column, ≥ 10 % of values have whitespace issues
- `lowercase` — column name contains `email`, `domain`, or `name` (substring), ≥ 10 %
- `uppercase` — `state`/`*_state` columns, values ≤ 3 chars are lowercase, ≥ 10 %
- `strip_legal_suffixes` / `lowercase` / `collapse_whitespace` — `company`, `account`, `name` columns, ≥ 10 % have legal suffixes
- `strip_www` / `strip_protocol` — `domain`, `website`, `url` columns, ≥ 10 % have URL prefixes
- `digits_only` / `strip_country_code` — `phone`, `mobile` columns, ≥ 10 % have non-digit chars
- `parse_dates` — ISO 8601-shaped strings in columns not ending with `_at`/`_date`, ≥ 80 %
- `normalize_state` — `state`/`*_state` columns, ≥ 60 % match US state names or codes

To apply a suggestion in a Model Spec staging model:

```yaml
columns:
  - name: company_name_clean
    expr: 'collapse_whitespace(lower(strip_legal_suffixes(company_name)))'
  - name: phone_clean
    expr: 'strip_country_code(digits_only(phone))'
```

To apply it in an entity graph resolution spec — **drop `parse_dates` from the transforms list before writing to `standardize`**, since it is not a valid enum value there. Handle date parsing in a Model Spec staging model using `parse_date(col, 'iso8601')` instead:

```yaml
standardize:
  - field: company_name
    transforms: [strip_legal_suffixes, lowercase, collapse_whitespace]
  - field: domain
    transforms: [strip_www, strip_protocol, lowercase]
  - field: phone
    transforms: [digits_only, strip_country_code]
```

## Interpretation Rules

- Confidence for cleaning suggestions ranges from 0.50 (10 % trigger rate) to 0.95 (100 %). Use `--confidence-min 0.7` to surface only suggestions with ≥ 50 % trigger rate.
- `--confidence-min` filters output after scanning; it does not change row count or sample behavior.
- Source refs and model names are better than raw table refs because they carry YAML metadata.
- Model Spec model `references` can produce target-backed FK hit rates. Source/direct table profiles usually emit only name-only FK guesses.
- Empty target key samples should not be treated as FK evidence.
- Prefer `--json` for agent workflows and `BOBSLED_CORE_OUTPUT_FORMAT=json` in CI.

## Quality Gates

After changing profiler behavior or docs, run the narrow checks first:

```bash
pnpm --dir packages/model-spec exec vitest run \
  tests/cli/profile.test.ts \
  tests/unit/profiler/profile.test.ts \
  tests/unit/profiler/sql.test.ts \
  tests/unit/compiler/expr/functions-cleaning.test.ts
pnpm --filter @bobsled-inc/model-spec typecheck
pnpm --filter @bobsled-inc/model-spec lint
```

Before handoff or PR update, run:

```bash
pnpm precommit
```
