# Golden-path quickstart

This example initializes the default DuckLake project, extracts three fictional
25-row CSV files with the built-in local file source, loads them, runs a SQL model,
and verifies 25 orders worth 3250 units. No account or API key is needed.

From the repository root, run `pnpm e2e:golden-path-quickstart`. For a manual run,
install `@bobsled-inc/dogsled` in a new directory and run:

```bash
dogsled init my-project
cd my-project
```

Copy this example's `data/`, `integrations/`, `resources/`, `sources/`, `models/`,
`extractor.yml`, `model-spec.yml`, and `lake-models.mjs` into that project. Install
Dogsled locally there so the JavaScript example can import its public exports.

```bash
dogsled extract validate local_files
for resource in customers products orders; do
  dogsled extract run --integration local_files "$resource" \
    | dogsled load run --dest ducklake \
        --ducklake-catalog-url ducklake:.dogsled/lake/catalog.ducklake \
        --target-schema bronze
done
dogsled model validate --integration local_lake
node lake-models.mjs
dogsled query "LOAD ducklake; ATTACH 'ducklake:.dogsled/lake/catalog.ducklake' AS lake; SELECT count(*) FROM lake.bronze.order_summary" --db-path query.duckdb
dogsled doctor --json
```

DuckLake downloads its open-source DuckDB extension on first use. The model
script registers a public DuckDB runner that attaches the catalog; the model CLI
currently has no DuckLake integration kind. Loading requires the explicit catalog
URL. The automated check runs the same commands in a disposable directory.

The automated walkthrough also serves 100 fictional posts from a loopback API,
extracts and loads them into the same DuckLake catalog, and checks the public
`source-query` command. This offline mirror replaces a public JSONPlaceholder
request so CI never depends on a third-party service. `showcase.mjs` shows the
complete API integration, resource, and live-source configuration.
