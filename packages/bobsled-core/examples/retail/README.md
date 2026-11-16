# Retail: which products need attention?

Build a local data project for a fictional home-goods retailer. Compare sales and
stock, add customer reviews from a separate API, and use AI to classify a small
support batch. All records are synthetic. Start with `bobsled onboarding guide
--tutorial retail`, or ask your agent to start the retail tutorial.

The starter includes source files, not a completed database or models. Ask your
agent to explain and build each chapter, then inspect its saved HTML evidence.
Completed teaching templates remain in the installed package; `onboarding guide`
returns `templatesPath`. Read a template when its lesson needs it.

Requires Node.js 24+, the Bobsled Core CLI and OpenSSL for a local development
certificate. No external service is needed for Chapters 1–5. The optional AI
chapter requires a supported provider account, consent and a chosen model.

## 1. Connect sources (`connect`)

Inspect `context/business-definitions.md`, the seven CSV exports under
`data/retail/`, and the API resource definitions. Validate the fixtures:

```sh
node validate.mjs
bobsled extract validate local_files
```

Create a short-lived local certificate. Keep its key in ignored `.local/`:

```sh
mkdir -p .local
openssl req -x509 -newkey rsa:2048 -nodes -keyout .local/localhost-key.pem \
  -out .local/localhost-cert.pem -days 2 -subj '/CN=localhost' \
  -addext 'subjectAltName=IP:127.0.0.1,DNS:localhost'
```

In a second terminal, start the loopback-only API. The token below is a synthetic
local fixture value, not a provider credential:

```sh
RETAIL_DEMO_API_TOKEN=local-retail-demo-token \
RETAIL_DEMO_TLS_CERT="$PWD/.local/localhost-cert.pem" \
RETAIL_DEMO_TLS_KEY="$PWD/.local/localhost-key.pem" node server.mjs
```

In the project terminal, explicitly allow this local API and trust its certificate:

```sh
export RETAIL_DEMO_API_TOKEN=local-retail-demo-token
export BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS=1
export NODE_EXTRA_CA_CERTS="$PWD/.local/localhost-cert.pem"
bobsled extract validate retail_api --check-env
bobsled onboarding verify connect
bobsled onboarding render
```

The source is lazy: this first query fetches all 96 reviews before applying the
sample limit, then caches them for one hour. Inspect the 17-record cursor pages
and the review/product keys. Keep the API running for Chapter 5. Never set
`NODE_TLS_REJECT_UNAUTHORIZED=0`.

## 2. Build an ETL pipeline (`load`)

Explain the local resource mappings and destination, then load the seven exports:

```sh
bobsled pipeline --integration local_files --dest duckdb --db-path data.duckdb
bobsled onboarding verify load
```

Inspect 24 products, four suppliers, four locations, 657 orders, 759 lines,
70 returns and 5,856 product/location/day inventory snapshots. API reviews cached
in `bronze` are separate from these warehouse tables.

## 3. Build semantic models (`model`)

Before calculating sales, read `context/retail.ontology.yml` and
`context/retail.mapping.yml`. A sales line refers to one product; that product
refers to its catalog supplier. One line can contain several units. Counting
lines therefore does not answer “How many units of this product sold?”

```sh
bobsled ontology list --json
bobsled ontology describe retail --concept SalesLine --yaml
bobsled ontology validate --strict --json
```

Follow the path `SalesLine → Product → Supplier` in the result. The mapping
connects it to `sales_order_lines.product_id` and `products.supplier_id`, using
the existing warehouse source definitions. The ontology explains what the things
are and how they relate. The semantic models below define the calculations,
including which orders count and how refunds change sales. These ontology checks
read definitions and need no database connection.

Inspection: explain why three sales lines do not necessarily mean three units
sold, and find the field that connects a product to its supplier. The files live
in `context/` to show that ontologies need no special folder.

Build and explain `returns_by_line`, `product_sales_summary`,
`product_in_stock_days` and `product_performance`, using the current chapter's
reference definitions as teaching material. Add the relevant metrics and
relationships after explaining their business meaning.

```sh
bobsled model validate --integration warehouse
bobsled model run +product_performance --integration warehouse
bobsled onboarding verify model
```

Explain the dependency chain, cancelled-order filter, refund subtraction and
calendar-day denominator. Show how those expressions affect an actual product.

## 4. Query product performance (`query`)

Compare products and discuss what additional evidence would help:

```sh
bobsled query "SELECT product_id, product_name, net_sales, in_stock_days, net_sales_per_in_stock_day FROM product_performance ORDER BY net_sales_per_in_stock_day DESC NULLS LAST LIMIT 5" --db-path data.duckdb
bobsled onboarding verify query
```

A high observed sales rate does not prove unmet demand. Do not equate reference
unit cost with fully burdened profit.

## 5. Query across sources (`federate`)

Keep the API environment from Chapter 1. Load reviews and support, then build
`product_review_summary` and `prepared_support_cases`:

```sh
bobsled pipeline --integration retail_api --dest duckdb --db-path data.duckdb
bobsled model run product_review_summary --integration warehouse
bobsled model run prepared_support_cases --integration warehouse
bobsled source-query "SELECT p.product_id, p.product_name, r.rating, r.review_text FROM product_performance p JOIN sources.external_reviews r USING (product_id) WHERE r.product_id = 'lmp-009' ORDER BY r.review_id LIMIT 10"
bobsled onboarding verify federate
```

Inspect both the direct API/warehouse join and the materialized review summary.
Explain cache reuse and its one-hour expiry. Of 40 prepared support cases, ten
have intentionally ambiguous product identity. Keep their product IDs null.

## 6. Build an agentic transformation (`transform`)

First obtain consent and provider/model choices using the Retail guide. Configure
the `review` role in `bobsled.yml` through environment references. Adapt the
`support_batch` and `support_case_classifications` templates. Put the model-backed
executor template at `executor.mjs`; its Bobsled Core and `zod` imports must resolve
from the project, using the installed package or a source-workspace link.

Start with `case-0001` as a pilot. A useful three-case batch also includes a stock
availability case and one ambiguous case; inspect the prepared source before
choosing and ask the learner to approve that batch.

```sh
bobsled model run support_batch --integration warehouse
bobsled model run support_case_classifications --integration warehouse \
  --agent-executor ./executor.mjs --agent-run-id retail-pilot \
  --agent-tokens-per-assignment 16384
bobsled onboarding verify transform --ticket-id case-0001
```

Inspect the pilot before more calls. For the remaining approved cases, change
`support_batch` to include only their IDs and build it. Run classifications under
a new run ID. The replace-by-key strategy preserves the pilot. Rebuild the batch
with every approved ID, then run `bobsled onboarding verify transform`. Never
rerun the pilot just to build the final comparison.

Inspect exact quotes, categories and product identity before marking reviewed.
These findings are analytical advice; no customer or stock action is performed.
Offline fixture execution is labelled as such and does not pass the AI chapter.
If the learner skips AI, leave that chapter incomplete and explain the choice.

## Review and resume

After each check, render the page, show the result and pause. Review only evidence
the learner inspected, using its checkpoint hash. Resume with `bobsled onboarding
status` and the journal. Rendering does not rerun checks or AI calls. Stop the
local API with Ctrl-C when finished.

`node generate.mjs` recreates the source fixtures deterministically;
`node validate.mjs` checks their integrity. Do not include a generated database,
certificates, provider secrets or local run state when sharing the starter.
