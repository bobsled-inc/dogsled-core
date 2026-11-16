# OSI round trip

Run `pnpm e2e:osi-roundtrip`. This example exports three fictional SQL models, two
metrics and one verified query to OSI profile `0.2.0.dev0`, checks the `BOBSLED`
extension vendor, imports into a fresh directory, validates the result, and compares
compiled SQL before and after. Imported column semantics are checked in the native
documents, and the verified query comes back unchanged under `verified_queries/`.

## Add business meaning with an ontology

`context/shop.ontology.yml` says that an Order is an individual purchase with an
identifier, an amount and a status. The `order_summary` model groups many orders
by status; its rows are not individual orders. This distinction matters when an
agent chooses which dataset to count.

`context/shop.mapping.yml` connects Order to `orders.id`, and its amount and
status relationships to `orders.amount` and `orders.status`. These fields come
from the existing `local_duckdb.orders` source. The ontology explains the
concepts; the semantic models and metrics supply transformations and calculations.

In a fresh copy of this example, before creating the `converted/` folder below:

```bash
dogsled ontology describe shop --concept Order --yaml
dogsled ontology validate --strict --json
dogsled ontology export --ossie-version 0.2.0.dev0 --out ../shop-ontology-export
dogsled ontology import ../shop-ontology-export/*.yml --json
```

The export directory must be new. It contains the ontology, its mapping, and the
mapped semantic scope. Import returns native file previews. Apply them in a
separate project to avoid duplicate identities. All of these checks run without
opening a database. Export to `0.1.1` fails because that version has no ontologies.

The automated showcase validates the definitions, tests that version error,
imports the exported bundle in a separate temporary project, then checks its
concepts, mappings and source references again.

## Round-trip the semantic models

To repeat manually after installing Dogsled in this example:

```bash
dogsled model validate --integration local_duckdb
dogsled model ossie export --all --name shop --ossie-version 0.2.0.dev0 --out shop.ossie.yml
dogsled model ossie import shop.ossie.yml --out converted
```

Copy the local `integrations/` into `converted/` before validating there; exchange
documents do not carry connection credentials. The output path must be new.
Known limitation: fully mapped native imports lack an explicit source-provenance
marker.
No database connection is opened by this round-trip test.
