# Retail guided tutorial

Ask your agent to **start the retail tutorial**, or ask to **get started with
Bobsled Core** and choose Retail. Existing projects resume their saved tutorial.
TV Night remains available through the same entry point.

Retail teaches six capabilities with synthetic home-goods data: source access,
ETL, semantic modeling, product queries, API/warehouse federation and agentic
support classification. It uses the same local HTML explorer, evidence checks
and guarded reviews as TV Night.

```sh
bobsled examples init retail --dir retail-project
cd retail-project
bobsled onboarding guide --tutorial retail
bobsled onboarding render
```

Follow the bundled README and your agent one chapter at a time. The starter has
source fixtures but no completed database or models. Node.js 24+, Bobsled Core and
OpenSSL are required. Chapters 1–5 use only local data and a local HTTPS API.

The optional AI chapter follows TV Night's consent controls: a chosen provider
and model, a bounded batch, one inspected pilot, explicit cost settings and no
unapproved retries. A pilot uses `bobsled onboarding verify transform --ticket-id
case-0001` and leaves chapter progress unchanged. Offline fixtures never count as
real AI completion. Skipping AI leaves that chapter incomplete.

The scenario asks which products need attention. Preserve business meaning:
exclude cancelled orders, subtract refunds, count distinct product-days with
stock, join by `product_id`, and leave ambiguous support product identity null.
Findings are analytical advice, not automatic customer or inventory actions.

For full setup, local certificate instructions and chapter commands, see the
[bundled walkthrough](../../packages/bobsled-core/examples/retail/README.md).

Chapter 3 also introduces customer ontologies. Follow `SalesLine → Product → Supplier`
in the [ontology](../../packages/bobsled-core/examples/retail/context/retail.ontology.yml)
and inspect its [data mapping](../../packages/bobsled-core/examples/retail/context/retail.mapping.yml).
The ontology explains why a sales line is not a unit sold; the semantic models
supply the quantities, filters and calculations. Use `bobsled ontology describe
retail --concept SalesLine --yaml` and `bobsled ontology validate --strict` before
building the models.
