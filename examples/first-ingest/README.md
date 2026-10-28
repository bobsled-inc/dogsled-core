# First Ingest Sample

This sample is the credential-free unified-ingest onboarding path. It shows one local PDF and one public API resource flowing through the same extractor protocol and into the same local DuckDB database — structured rows and unstructured chunks landing side by side without any external credentials. Source credentials stay in `integrations/*.yml`, and the load destination is passed as loader flags.

From this directory:

```bash
./walkthrough.sh
```

The walkthrough validates the specs, removes only demo-generated local artifacts, captures a small extractor protocol JSONL sample, loads the local PDF streams and public GitHub repos into `first-ingest.duckdb`, then prints sample rows from:

- `first_pdf__documents`
- `first_pdf__chunks`
- `first_pdf__parse_errors`
- `first_pdf__acl`
- `public_repos`

The GitHub sample uses unauthenticated public API access, so it is rate limited by GitHub. For production use, switch `auth.type` in `integrations/github_public.yml` to `bearer` and set `token: ${{ env.GITHUB_API_TOKEN }}`. Add `auth_env_vars: [GITHUB_API_TOKEN]` to the integration and set that environment variable.

The default walkthrough does not require Bedrock, embedding, or API credentials.'s connection-free path is extract/load/query only; embeddings can be layered on later when a supported embedder config is present.

If you are running from a source checkout without a standalone `dogsled` binary, `walkthrough.sh` uses the repo-local CLI automatically. You can also set `DOGSLED_CLI` explicitly:

```bash
DOGSLED_CLI="node ../../packages/dogsled/dist/index.js" ./walkthrough.sh
```

## Manual Commands

Run the same flow by hand:

```bash
dogsled extract validate
dogsled extract run --integration local_docs first_pdf \
  | dogsled load run --dest duckdb --db-path ./first-ingest.duckdb --target-schema main

dogsled query \
  "SELECT source_uri, parser_version FROM first_pdf__documents" \
  --db-path ./first-ingest.duckdb
```

Then run the public API sample:

```bash
dogsled extract run --integration github_public public_repos --limit 5 \
  | dogsled load run --dest duckdb --db-path ./first-ingest.duckdb --target-schema main

dogsled query \
  "SELECT name, stargazers_count FROM public_repos ORDER BY stargazers_count DESC LIMIT 5" \
  --db-path ./first-ingest.duckdb
```
