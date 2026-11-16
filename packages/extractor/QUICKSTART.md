# Extractor CLI — Local Testing Quickstart

End-to-end walkthrough for testing the CLI against a real API.

## Prerequisites

```bash
cd packages/extractor
pnpm install
pnpm run build
```

After build, the CLI is available at `./dist/index.js`. You can run it two ways:

**Option A: Built CLI (after `pnpm run build`)**

```bash
alias dogsled="node $(pwd)/dist/index.js"
```

**Option B: Dev mode with tsx (no build, runs from source)**

```bash
# Must use --prefix-paths so pnpm resolves deps from the package dir
EXTRACTOR_DIR="$(pwd)"
alias dogsled="pnpm --dir=$EXTRACTOR_DIR tsx $EXTRACTOR_DIR/src/index.ts"
```

Both work from any directory. Option A is faster; Option B picks up source changes immediately.

---

## 1. Scaffold a Test Project

```bash
mkdir -p /tmp/extractor-test && cd /tmp/extractor-test

dogsled extract init . --integration github
```

This creates:

```
extractor.yml
providers/github.yml       # provider spec (base URL, auth, rate limits)
resources/github/items.yml  # resource spec (endpoint, output fields, pagination)
.gitignore
```

---

## 2. Set Up a GitHub Connection (Real API)

Replace the scaffolded provider with a real GitHub config.

**providers/github.yml:**

```yaml
spec_version: '1'
type: provider
name: github
description: GitHub REST API v3
transport:
  base_url: https://api.github.com
  auth:
    type: bearer
    token: '${{ env.GITHUB_TOKEN }}'
  timeout_ms: 30000
  retry:
    retry_on: [429, 503]
    max_retries: 3
    backoff: exponential
    retry_after_header: true
  rate_limit:
    requests_per_second: 10
    burst: 20
  headers:
    Accept: application/vnd.github.v3+json
    User-Agent: bobsled-core-extractor/0.1
```

**resources/github/repos.yml:**

```yaml
spec_version: '1'
type: resource
name: repos
provider: github
description: Public repos for an org

api:
  endpoint: '/orgs/${{ input.org }}/repos'
  method: GET
  query_params:
    per_page: '${{ input.per_page }}'

input:
  org:
    type: string
    default: bobsled-inc
  per_page:
    type: integer
    default: 10

output:
  id:
    type: integer
    path: '$.id'
  name:
    type: string
    path: '$.name'
  full_name:
    type: string
    path: '$.full_name'
  private:
    type: boolean
    path: '$.private'
  created_at:
    type: timestamp
    path: '$.created_at'
  updated_at:
    type: timestamp
    path: '$.updated_at'
  owner_login:
    type: string
    path: '$.owner.login'

extract:
  record_path: '$'
  pagination:
    type: link_header
  table:
    primary_key: [id]
```

**resources/github/issues.yml:**

```yaml
spec_version: '1'
type: resource
name: issues
provider: github
description: Issues for a repo

api:
  endpoint: '/repos/${{ input.owner }}/${{ input.repo }}/issues'
  method: GET
  query_params:
    state: all
    per_page: '${{ input.per_page }}'

input:
  owner:
    type: string
    default: bobsled-inc
  repo:
    type: string
    default: demo-repo
  per_page:
    type: integer
    default: 100

output:
  id:
    type: integer
    path: '$.id'
  title:
    type: string
    path: '$.title'
  state:
    type: string
    path: '$.state'
  created_at:
    type: timestamp
    path: '$.created_at'
  updated_at:
    type: timestamp
    path: '$.updated_at'
  user_login:
    type: string
    path: '$.user.login'

extract:
  record_path: '$'
  pagination:
    type: link_header
  incremental:
    cursor_field: updated_at
    cursor_param: since
  table:
    primary_key: [id]

lookup:
  description: Fetch a single issue by number
  api:
    endpoint: '/repos/${{ input.owner }}/${{ input.repo }}/issues/${{ input.id }}'
    method: GET
  input:
    id:
      type: string
      required: true
    owner:
      type: string
      default: bobsled-inc
    repo:
      type: string
      default: demo-repo
```

Set your token:

```bash
export GITHUB_TOKEN="ghp_your_token_here"
```

---

## 3. Validate Specs

```bash
# Validate all providers and resources
dogsled extract validate

# Validate a specific provider
dogsled extract validate github

# Validate a specific resource
dogsled extract validate github/issues

# Also check that env vars are set
dogsled extract validate --check-env

# JSON output
dogsled extract validate --format json
```

---

## 4. Discover Resources

```bash
# List resources defined for the github provider
dogsled extract discover github

# Also verify API connectivity
dogsled extract discover github --check-api

# Probe: infer output fields from a live API response
dogsled extract discover github --probe

# JSON output
dogsled extract discover github --format json
```

---

## 5. Run Extraction

```bash
# Extract all resources from all providers (stdout JSONL)
dogsled extract run

# Extract a specific resource
dogsled extract run repos --integration github

# Limit records (great for testing)
dogsled extract run issues --integration github --limit 5

# Override input variables
dogsled extract run repos --integration github --input org=octocat

# Full refresh (ignore any saved bookmarks)
dogsled extract run issues --integration github --full-refresh --limit 10

# Write to files instead of stdout
dogsled extract run repos --integration github --output file --limit 20

# Lint mode: validate responses + detect schema drift
dogsled extract run repos --integration github --lint --limit 10

# Batch mode: write batch files instead of individual records
dogsled extract run repos --integration github --batch --batch-size 5 --limit 20

# Pretty logs (human-readable stderr instead of JSON)
dogsled extract --log-format pretty run repos --integration github --limit 5
```

**What you'll see on stdout** (JSONL):

```jsonl
{"_v":1,"type":"SCHEMA","stream":"repos","schema":{...},"key_properties":["id"]}
{"_v":1,"type":"RECORD","stream":"repos","record":{"id":123,"name":"..."},"time_extracted":"..."}
{"_v":1,"type":"STATE","stream":"repos","value":{"cursor_field":null,"cursor_value":null,...}}
```

**What you'll see on stderr** (control messages):

```jsonl
{"_v":1,"type":"LOG","level":"info","message":"Starting extraction: github/repos",...}
{"_v":1,"type":"METRIC","stream":"repos","metrics":{"records_emitted":10,"api_calls":1,...},...}
```

Tip: Separate data from logs:

```bash
dogsled extract run repos --integration github --limit 5 > records.jsonl 2> logs.jsonl
```

---

## 6. Lookup a Single Record

```bash
# Fetch a single issue by number
dogsled extract lookup --integration github --resource issues --input id=1

# With overridden repo
dogsled extract lookup --integration github --resource issues --input id=1 --input owner=octocat --input repo=hello-world
```

---

## 7. Incremental Top-up

Bookmarks live in `.extractor/state.json`, keyed by `integration/resource`. Incremental `run` and `topup` emit `STATE` messages, but durable bookmarks only advance when you pass `--advance-state`. `--limit` runs stay preview-only.

```bash
# Durable incremental run: persists the bookmark for the next run
dogsled extract run issues --integration github --advance-state

# Preview incremental run: emits STATE but does not persist the bookmark
dogsled extract run issues --integration github --limit 5

# Top-up: backfill the last 2 hours (does NOT advance bookmark by default)
dogsled extract topup --integration github --resource issues --since 2h

# Top-up with an explicit window
dogsled extract topup --integration github --resource issues \
  --since 2026-03-01T00:00:00Z --until 2026-03-15T00:00:00Z

# Top-up and advance the bookmark
dogsled extract topup --integration github --resource issues --since 1d --advance-state

# Limit records
dogsled extract topup --integration github --resource issues --since 7d --limit 50
```

---

## 8. Inspect State

Bookmarks are stored as JSON in `.extractor/state.json`:

```bash
cat .extractor/state.json | jq .
```

Example:

```json
{
  "version": 1,
  "streams": {
    "github/issues": {
      "cursor_field": "updated_at",
      "cursor_value": "2026-03-20T18:30:00Z",
      "last_run_at": "2026-03-23T10:00:00Z",
      "record_count": 42
    }
  }
}
```

To reset state for a fresh run:

```bash
rm -rf .extractor/
```

---

## 9. Generate Model Spec Source

Emit a Model Spec source YAML alongside extraction:

```bash
dogsled extract run repos --integration github --limit 5 --emit-model-spec-source
```

The generated Model Spec source spec appears in the stderr log output.

---

## Quick Test Checklist

| Test                      | Command                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Scaffolding works         | `dogsled extract init /tmp/test-project --integration test_api`                                               |
| Validation passes         | `dogsled extract validate`                                                                                    |
| Env var check             | `dogsled extract validate --check-env`                                                                        |
| Discovery lists resources | `dogsled extract discover github`                                                                             |
| API connectivity          | `dogsled extract discover github --check-api`                                                                 |
| Schema probe              | `dogsled extract discover github --probe`                                                                     |
| Extraction (limited)      | `dogsled extract run repos --integration github --limit 5`                                                    |
| Incremental extraction    | `dogsled extract run issues --integration github --advance-state` then rerun the same command (uses bookmark) |
| Full refresh              | `dogsled extract run issues --integration github --full-refresh --limit 5`                                    |
| Lookup                    | `dogsled extract lookup --integration github --resource issues --input id=1`                                  |
| Top-up                    | `dogsled extract topup --integration github --resource issues --since 1h --limit 10`                          |
| File output               | `dogsled extract run repos --integration github --output file --limit 5`                                      |
| Batch output              | `dogsled extract run repos --integration github --batch --limit 20`                                           |
| Lint mode                 | `dogsled extract run repos --integration github --lint --limit 5`                                             |
| Input overrides           | `dogsled extract run repos --integration github --input org=octocat --limit 5`                                |
| JSON formats              | `dogsled extract validate --format json` / `dogsled extract discover github --format json`                    |
| Pretty logs               | `dogsled extract --log-format pretty run repos --integration github --limit 3`                                |

---

## Troubleshooting

**"No providers found"** — Run from the directory containing `extractor.yml` (or `providers/`).

**Auth failures** — Ensure `GITHUB_TOKEN` is exported. Use `dogsled extract validate --check-env`.

**"base_url origin mismatch"** — The URL in the provider spec must be a root HTTPS origin with no trailing path.

**Empty output** — Check stderr for error messages. Stdout is data only; logs go to stderr.
