# OSI round trip

Run `pnpm e2e:osi-roundtrip`. This example exports three fictional SQL models, two
metrics and one verified query to OSI profile `0.2.0.dev0`, checks the `DOGSLED`
extension vendor, imports into a fresh directory, validates the result, and compares
compiled SQL before and after. Imported column semantics are checked in the native
documents, and the verified query comes back unchanged under `verified_queries/`.

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
