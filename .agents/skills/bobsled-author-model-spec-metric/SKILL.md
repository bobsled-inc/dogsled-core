---
name: bobsled-author-model-spec-metric
description: Author a Model Spec metric YAML — a named semantic measure layered on top of one or more Model Spec models. Covers single-model and multi-model metrics, expressions, synonyms, and tags.
exposed: true
triggers:
  - author model spec metric
  - define a metric
  - add a metric
  - create metric definition
  - kpi definition
  - semantic metric
  - revenue metric
  - arr metric
  - model spec metric
  - metric expression
---

# Author a Model Spec metric

Use this skill when a user wants to declare a named semantic measure
(e.g. _ARR_, _gross margin_, _active users_) that downstream consumers
— a host application, BI tools, the query planner — should read out of one
or more Model Spec models.

Metrics are **metadata entities**: they don't produce DDL. The
compiler parses them, validates their references, and emits them as
JSON alongside SQL when `--include-metadata` is set.

## Where the file goes

Place each metric in its own file under the project's `metrics/`
directory (configurable via `metrics_dir` in `model-spec.yml`, defaults to
`metrics/`). One metric per file.

## Schema (canonical)

```yaml
spec_version: '0.2'
type: metric
name: <identifier> # must match identifierRegex; required
description: Short human-readable explanation # optional
model: <model_name> # single-model metrics
# — OR —
models: # multi-model metrics (ratios, sums across models)
  - <model_a>
  - <model_b>
expression: SUM({fct_orders}.order_total) # required; SQL-ish, {ref} tokens resolve to qualified identifiers
synonyms: # optional; alternative phrasings for NL → metric retrieval
  - net revenue
  - bookings
tags: # optional; surfaced by the Data Estate UI
  - finance
  - tier-1
```

**Required:** `spec_version`, `type`, `name`, `expression`, and at
least one of `model` or `models`.

## Workflow

1. **Pick the model(s).** A metric must declare which Model Spec model it
   reads from. Use `model:` for single-model metrics, `models:` for
   ratios or cross-model aggregates.
2. **Write the expression.** Use `{model_name}` tokens to reference
   models. The compiler validates every token resolves to a real
   model at `bobsled model validate` time. Cross-dialect SQL
   functions are auto-transpiled (see the `bobsled-author-model-spec-model` skill
   and `bobsled-model-spec-expressions` reference for the function catalog).
3. **Add synonyms (encouraged).** The query planner uses synonyms
   for NL-to-metric retrieval. Add 2–5 phrasings the user might
   actually say (e.g. "monthly recurring revenue", "MRR",
   "subscription revenue" for an `mrr` metric).
4. **Tag for discoverability.** Tags drive Data Estate UI filtering;
   `finance`, `growth`, `core-kpi` are typical.
5. **Validate.** `bobsled model validate --integration <handle>`
   checks model refs and basic structure.

## Concrete example

```yaml
spec_version: '0.2'
type: metric
name: monthly_recurring_revenue
description: Total active subscription revenue normalized to a monthly cadence.
model: fct_subscriptions
expression: |
  SUM(
    CASE
      WHEN {fct_subscriptions}.billing_cadence = 'yearly'
        THEN {fct_subscriptions}.amount / 12
      ELSE {fct_subscriptions}.amount
    END
  )
synonyms:
  - mrr
  - monthly recurring revenue
  - subscription revenue
tags:
  - finance
  - core-kpi
```

## Validation caveats

- `expression` is opaque to the compiler — column references inside
  aggregates aren't checked against the model's `schema.columns`. A
  typo like `SUM({fct_orders}.totl)` slips through validation and
  blows up only at query time.
- Multi-model metrics (`models:` with >1 entry) don't carry an
  implicit join. The expression must include the join logic
  explicitly, OR rely on a relationship spec that downstream planners
  can use (see `bobsled-author-model-spec-relationship`).

## Related skills

- `bobsled-author-model-spec-model` — author the underlying model the metric reads.
- `bobsled-author-model-spec-relationship` — declare the joins between models a
  multi-model metric spans.
- `bobsled-author-model-spec-vq` — author a verified SQL query that returns the
  metric value pre-aggregated.

For programmatic edits (mutating an existing metric from code rather
than authoring from scratch), see the `bobsled-model-spec-edit` skill —
`updateMetric()` is the validated entry point.
