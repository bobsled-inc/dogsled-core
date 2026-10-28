---
name: extractor-query-authoring
description: Add a query block to an extractor resource so it becomes callable through queryResource() and queryResources with MongoDB-compatible filter syntax.
---

# Authoring a query block

This is a maintainer workflow for implementing `query:` blocks. The
`extract-pipelines` skill is authoritative for user-facing filter capability,
exact operator vocabularies, pushdown behavior, incremental composition, and
pipeline operation. If this implementation guide conflicts with it, fix this
guide rather than creating a second capability contract.

## Filter DSL

Callers use MongoDB-compatible operator syntax. Query-resource filters support
exactly `eq`, `contains`, `gte`, `lte`, `ne`, `lt`, `gt`, `not`, and `in`.
The `$` prefix is optional, and a scalar value is shorthand for `$eq`. Do not
confuse query `ne` with the extract-predicate spelling `neq`.

## Operator alignment

Agents should treat the supported operators as direct SQL-token equivalents:

- `$eq` or `eq` maps to `=`
- `$contains` or `contains` maps to containment
- `$gte` or `gte` maps to `>=`
- `$lte` or `lte` maps to `<=`
- `$ne` or `ne` maps to `!=`
- `$lt` or `lt` maps to `<`
- `$gt` or `gt` maps to `>`
- `$not` or `not` negates the comparison
- `$in` or `in` maps to set membership

Examples:

- `{ state: 'open' }`
- `{ state: { eq: 'open' } }`
- `{ updated_at: { $gte: '2026-04-01T00:00:00Z' } }`

## When to use this skill

- Make an existing API resource queryable
- Add caller-facing filters to a resource
- Add native search support to a resource that already has a provider DSL

## Prerequisites

- The resource is an HTTP API resource with existing `api`, `input`, `output`, and `extract` blocks
- Query bindings target existing optional inputs
- Search bindings target existing string inputs

## Workflow

1. Read the resource YAML and identify scalar output fields that make sense as caller-facing filters.
2. Run `dogsled extract validate <integration>` to catch schema/config issues early.
3. Run `dogsled extract verify <integration>`.
4. Run `dogsled extract verify <integration> --mock`.
5. If `meta.yml` has `openapi_url`, run `dogsled extract check <integration>` for parameter/type hints.
6. Decide which operators each field supports.
7. Bind each operator to an existing optional input.
8. Add `query.filters` and/or `query.search` to the resource YAML.
9. Run `pnpm --filter @bobsled-inc/extractor test -- query`.
10. Run `pnpm --filter @bobsled-inc/integrations test:unit` if the resource ships from the integrations package.
11. If the resource should also get a curated typed wrapper, switch to `.agents/skills/query-wrapper-authoring/SKILL.md` after the YAML work is validated.

## Templates

```yaml
query:
  filters:
    state:
      operators: [eq]
      enum: [open, closed]
      bind:
        eq:
          input: state
    updated_at:
      operators: [gte, lte]
      bind:
        gte:
          input: since
        lte:
          input: until
```

```yaml
query:
  search:
    dialect: jira_jql
    bind:
      input: jql
    docs: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/
```

## Common pitfalls

- Binding to a required input
- Binding the same input in two places
- Pointing a filter at an `array` or `object` output field
- Forgetting that `query:` and `extract.incremental` solve different problems
- Assuming defaults on bound inputs still apply during `queryResource()` calls
- Using unsupported operators such as `$regex`, or using extract-predicate
  `neq` where query filters require `ne`

## Pushdown for `extract.where`

The `compile` block on a `query.filters[<field>]` entry is also what powers
pushdown for resource-side `extract.where` predicates. When a resource author writes:

```yaml
extract:
  where:
    - field: last_edited_time
      gte: '-6mo'
```

Dogsled inspects `resource.query.filters.last_edited_time.compile.gte`:

- `mode: http_query` → predicate value lands in the URL query param named by
  `param` (or `bind.gte.input` if `param` is omitted).
- `mode: direct_arg` → predicate value lands in an MCP tool argument named by
  `argument` (or `bind.gte.input`).
- No matching binding → predicate stays in the client-side remainder and
  evaluates after `mapResponse`.

`filter_dsl` is available to query-resource execution for provider-native
filter expressions, but it is not an `extract.where` pushdown mode.

Practical implication: when adding a comparison-operator filter to a new HTTP
resource, prefer `compile: { mode: http_query, param: <api_param_name> }`.
That single declaration unlocks both `queryResource(...)` and
`extract.where` pushdown. Use `extract-pipelines` for the authoritative filter
vocabularies and runtime semantics.

## JSONPath dialect for `output.path` / `extract.record_path`

This is the **canonical reference** for the path dialect used by `output.<field>.path`,
`output.<field>.paths`, `extract.record_path`, and `after_response` hook `unwrap`.
The resolver is `extractJsonPath` (`src/framework/runtime/output-mapper.ts`), backed by
`parseJsonPathTokens` (`src/framework/core/json-path.ts`). It is **three-tiered**, and
only the first tier is a contract Dogsled tests and supports.

### Tier 1 — SUPPORTED (deterministic, tested)

A path is parsed by the supported tokenizer when it is `$` or starts with `$.` and every
dotted segment matches `^([A-Za-z_][A-Za-z0-9_]*)(?:\[(-?\d+)\])?$`. Use only these:

| Path            | Meaning                                       |
| --------------- | --------------------------------------------- |
| `$`             | the whole record                              |
| `$.prop`        | top-level property                            |
| `$.a.b.c`       | nested properties                             |
| `$.arr[0]`      | positive array index                          |
| `$.data[-1].id` | **negative index** (from the end) — supported |

- Property names must match `[A-Za-z_][A-Za-z0-9_]*`. Notion-style keys like
  `heading_1`, `rich_text`, `code` qualify.
- A supported path that doesn't resolve returns `undefined`, which falls through to the
  field's `default` (or is omitted). It never throws.

### Tier 2/3 — NOT SUPPORTED (do not use in `output.path` / `record_path`)

Any path the supported tokenizer rejects falls through to `jsonpath-plus@10.4.0` with
`wrap: true`. **That fallthrough is unspecced and untested by Dogsled** — treat it as
undefined behavior, not a feature. Do **not** use any of these:

- wildcards — `$.*`, `$.a[*]`
- recursive descent — `$..x`
- quoted / bracket keys — `$['a-b']`
- hyphenated keys — `$.a-b`
- filter expressions — `$.a[?(@.x)]`
- array slices — `$.a[0:2]`
- unions — `$.a[0,1]`

Two concrete failure modes make these silently wrong:

- **Multi-match → array → garbage.** On more than one match, `jsonpath-plus` returns an
  **array**, which the type coercion then stringifies into junk for a scalar field
  (e.g. `"[object Object],[object Object]"`).
- **Zero-match → silent null.** On no match it yields `undefined`, so the column silently
  takes the field's `default` (or `null`) with no error and no signal.

> These tiers are **not** "prefer wildcards over recursive descent." Both wildcards and
> recursive descent are unsupported tier-2/3 — any difference in what they return is an
> incident of the payload shape, not a contract. If you need "all matches," shape the
> data with `extract.record_path` to a real array and map per-record, or capture the
> container as `type: object` and unfurl it in model SQL.

The same `extractJsonPath` resolver powers the `unwrap` field of `after_response` hooks,
so these exact tier-1 rules apply there too.

### When one record can carry the value under different keys

For type-discriminated payloads (e.g. Notion blocks, where the text lives under a key
equal to the block type), use the ordered `output.<field>.paths` fallback — the first
tier-1 path that resolves wins, ahead of `default`:

```yaml
output:
  text:
    type: string
    paths:
      - $.paragraph.rich_text
      - $.heading_1.rich_text
      - $.code.rich_text
    default: null
```

This resolves the discriminated union in one field without a downstream COALESCE. It is
the supported alternative to a wildcard — keep every entry inside tier-1 grammar. See the
"type-discriminated nested payloads" recipe in the `add-custom-api-integration` skill.

## Hand-off to integrations-side wrapper work

Once the YAML query surface is valid and discoverable, do not keep extending this skill for TypeScript wrapper work. Move to:

- `.agents/skills/query-wrapper-authoring/SKILL.md`

That skill covers wrapper naming, metadata registration, README/table sync, tests, and the current `makeQuerySource` typing limitation.

MongoDB is a trademark of MongoDB, Inc. This project is not affiliated with or endorsed by MongoDB, Inc.
