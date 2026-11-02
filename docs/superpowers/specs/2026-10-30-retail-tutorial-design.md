# Guided retail tutorial

## Intent

Add a second built-in Dogsled tutorial using the shared framework. Teach a learner
to answer: “Which products need attention, and what do sales, stock and customer
feedback tell us?” Use a fictional home-goods retailer and reproducible data.

## Approach

Use a `retail` tutorial definition, bundled example, and teaching skill. Reuse the
existing progress, verification, review, and offline HTML engine. This follows the
chosen two-stage approach: extract the framework first, then add retail content.
A separate tutorial application would duplicate those controls. Expanding TV
Night with retail conditions would mix unrelated lessons. Neither is proposed.

## Learner journey

1. Connect sources: inspect the local warehouse exports and start the loopback
   HTTPS API for reviews and support. Explain pagination and environment-based
   authentication. Check a small read before loading data.
2. Load data: load seven warehouse CSVs into the project DuckDB database. Inspect
   row counts and key relationships; API feedback remains a separate source.
3. Build semantic models: construct product performance from sales, refunds and
   stock. Explain cancelled orders, distinct product-days and reference costs.
4. Query products: compare net sales and sales per in-stock day. Identify products
   for further investigation. Do not describe this ratio as lost demand or profit.
5. Query across sources: join API reviews to warehouse products by `product_id`.
   Explain and inspect the lazy cache. Load support conversations and prepare
   cases without assigning a product to ambiguous multi-product orders.
6. Transform support text: classify a small, explicit batch into typed issue,
   resolution and evidence fields. Inspect the evidence before reviewing results.
   Summarize findings as analytical advice, with no customer or inventory actions.

Each chapter explains its goal, shows files and query results, records checked
evidence, and pauses for the learner's review using the existing page controls.

## Data and packaging

Adapt the existing deterministic retail demo's generator, source fixtures and
business definitions. Bundle only synthetic source data and necessary teaching
files. Do not include its populated database, runtime state, certificates,
credentials, machine paths or obsolete repository references.

Keep completed model templates under the example's excluded `reference/`
directory. Scaffold a starting project so learners build the models during the
lessons. Preserve seven derived models: returns by line, sales summary, in-stock
days, product performance, review summary, prepared support cases and support
classifications. Retain a reproducible generator and integrity validation.

## AI choice

Use the same AI flow as TV Night, as requested: real AI after explicit consent,
with the option to skip the AI lesson. Keep the offline executor for deterministic
tests and clearly labelled demonstrations; it does not complete the real AI
lesson. AI usage approval from an earlier TV Night test does not cover this
tutorial's development tests.

Teach one pilot, then the rest of a small approved batch. Reuse existing provider,
budget and typed outcome contracts. Keep retries off unless separately approved.
Check that the pilot does not mark the whole chapter complete. Preserve null
product identity and distinguish valid structured output from reviewed evidence.

## Boundaries and builder choices

Register the definition in the built-in registry. Project files select an ID and
cannot supply executable tutorial code. Add a retail skill and make the general
tutorial entry point offer both examples while preserving existing TV Night use.
Keep retail-specific SQL, validation, lessons and display settings in its own
directory. Only extend the shared interface when the second tutorial demonstrates
a real need; cover any change with TV Night regression tests.

The builder may choose chapter IDs, lesson wording, representative products and
the small classification batch. Check meaningful invariants, not just the
presence of tables. Treat all imported example material as new public content.
Retain loopback HTTPS, explicit private-host opt-in and local certificate trust;
do not disable TLS checks globally. Do not add dependencies or external services.

## Verification and delivery

Test tutorial selection and identity isolation, chapter checks, unsafe inputs,
HTML rendering and legacy TV Night behavior. Run a fresh retail project through
the local API, load, model, federation and offline transformation paths. Mock AI
in automated tests; live calls need separate consent. Check both tutorial pages
in a browser. Run security checks and `pnpm precommit` before shipping.

Use branch `codex/retail-guided-tutorial`, based on the shared-framework commit
`9972190`. Open a draft stacked PR targeting `codex/shared-tutorial-framework`.
Keep the dependency on PR #18 explicit. Retarget and recheck against main after
the parent merges, accounting for a possible squash merge. Sign off every commit.
