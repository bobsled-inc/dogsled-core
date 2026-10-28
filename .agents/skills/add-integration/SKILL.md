---
name: add-integration
description: Add a new API integration to the @bobsled-inc/integrations library. Automates OpenAPI spec discovery, YAML generation, curation, and validation.
exposed: true
triggers:
  - add new integration
  - create api integration
  - onboard new data source
  - generate integration yaml
  - add stripe integration
  - add api connector
  - build integration from openapi
  - add new api to dogsled
---

# Add Integration

Automates adding a new API integration to `packages/integrations/`. Leverages `dogsled extract generate` for OpenAPI-based generation, with fallback to manual authoring.

## Usage

```
/add-integration <service-name>
```

Example: `/add-integration stripe`

## Workflow

### Step 1: Check if integration already exists

```bash
ls packages/integrations/integrations/<name>/
```

If it exists, ask the user whether to regenerate/update or abort.

### Step 2: Find the OpenAPI spec

1. Search the web for `<service-name> OpenAPI spec` or `<service-name> API specification`
2. Common locations:
   - GitHub repos (e.g., `github.com/<org>/openapi`)
   - Official docs (e.g., `docs.<service>.com/openapi.json`)
   - SwaggerHub, APIs.guru
3. If no OpenAPI spec exists, fall back to **manual authoring** (Step 2b)

### Step 2b: Manual authoring (no OpenAPI spec)

1. Fetch the API documentation using WebFetch
2. Identify the base URL, auth method, and key endpoints
3. Write `integration.yml` and resource YAMLs by hand following the patterns in `packages/integrations/integrations/_template/`
4. Skip to Step 5

### Step 3: Generate YAMLs from OpenAPI

```bash
cd packages/dogsled && pnpm dev extract generate <openapi_url> --directory /tmp/integration-staging --integration <name>
```

Read all generated files in `/tmp/integration-staging/`.

### Step 4: Review and curate

1. Read each generated file
2. Resolve all `# REVIEW:` annotations — make decisions, remove the markers
3. **Curate resources** — keep the most useful endpoints (the 80% use case):
   - Keep: list endpoints, get-by-id endpoints, search endpoints
   - Remove: internal/admin-only endpoints, webhook management, bulk operations
4. For large APIs (e.g., AWS with 200+ services), ask the user which resource groups to include
5. **Wire up `for_each` for child endpoints** — If a resource's endpoint contains a path parameter referencing a sibling resource (e.g., `/campaigns/${{ input.campaign_id }}/leads`), add a `for_each` block in the `extract` section:

   ```yaml
   extract:
     for_each:
       resource: campaigns # sibling resource to iterate over
       field: id # field from the parent resource
       input: campaign_id # maps to this resource's required input
       concurrency: 1 # optional, 1..64 — iterations in flight. Default 1 (sequential).
   ```

   The test suite will catch missing `for_each` configs automatically.

   If the child response does not repeat the parent key, retain it by declaring a
   typed contextual field in the child's canonical `output` schema:

   ```yaml
   output:
     campaign_id:
       type: string
       from:
         resource: campaigns
         path: $.id

   extract:
     for_each:
       resource: campaigns
       field: id
       input: campaign_id
     table:
       primary_key: [campaign_id, id]
   ```

   `from.resource` must be the immediate parent or a proven ancestor in the same
   `for_each` chain. `from.path` resolves only through that ancestor's declared,
   mapped `output`; it cannot expose inputs, raw responses, headers, auth, or
   environment values. The child field type must match the referenced output type,
   and `from` cannot be combined with `path` or `paths`. Nested paths require the
   ancestor output to declare the traversed `properties`/`items` shape. Dogsled does
   not add contextual fields to the primary key, so declare a composite key
   explicitly when child IDs are parent-scoped. A targeted child run can reconstruct
   only an immediate-parent field exactly matched by an explicit `for_each` input
   binding; all other ancestry must be co-scheduled.

   **`concurrency:` notes.** Default `1` keeps the legacy sequential behavior. Raising it overlaps in-flight iterations against the existing integration `rate_limit` token bucket — the rps cap from `integration.yml` remains absolute, so setting `concurrency` above `rate_limit.burst` just queues against the bucket. Raise it for large fan-outs where per-request RTT (not the rps budget) is the bottleneck (e.g. thousands of child reads against a 3 rps API). A failing iteration logs a warning and does not cancel siblings.

6. **Add incremental sync where supported** — if an endpoint exposes a
   since/updated-after parameter or time filter, set `extract.incremental` so
   the connector pulls only new or changed rows instead of full-refreshing every
   run (see **Incremental sync (cursors)** below).
7. Ensure every resource has:
   - A non-empty `description`
   - `extract.table.primary_key` set
   - At least one output field with a valid JSONPath
   - HTTPS-only URLs

### Step 5: Create `meta.yml`

Create `packages/integrations/integrations/<name>/meta.yml` with:

```yaml
display_name: <Human-readable name>
category: <one of: developer-tools, crm, marketing, finance, communication, analytics, cloud-infra, productivity>
tags: [<relevant tags>]
logo_url: <favicon or logo URL>
docs_url: <official API docs URL>
openapi_url: <source OpenAPI spec URL, if used>
auth_setup:
  - env: <ENV_VAR_NAME>
    description: <what this token/key is>
    docs_url: <link to auth docs>
```

Declare every referenced environment variable in `auth_env_vars`, including optional headers. Bundled `<name>/source.yml` files can also use declarations from their `meta.yml` `auth_setup`. Optional headers are omitted when a declared variable is absent or empty.

### Step 6: Move to library

```bash
mkdir -p packages/integrations/integrations/<name>/resources
```

Copy finalized `integration.yml` and resource YAMLs into position:

- `packages/integrations/integrations/<name>/integration.yml`
- `packages/integrations/integrations/<name>/meta.yml`
- `packages/integrations/integrations/<name>/resources/<resource>.yml`

### Step 7: Validate and check against OpenAPI spec

Run validation and OpenAPI diff checks — these catch most config issues without needing API credentials:

```bash
# Static validation: schema correctness + input completeness
dogsled extract validate --integration <name>

# OpenAPI spec diff: endpoint mismatches, field type drift, missing fields
# Auto-resolves the OpenAPI URL from meta.yml if openapi_url is set
dogsled extract check <name>

# Or provide the URL explicitly:
dogsled extract check <name> --openapi <openapi-url-or-path>
```

**Fix all errors before proceeding.** Warnings are informational — review but don't necessarily fix:

| Severity | Action                                                                      |
| -------- | --------------------------------------------------------------------------- |
| `error`  | Must fix: endpoint not found, method mismatch, missing required body fields |
| `warn`   | Review: field type mismatches, pagination drift, aggressive rate limits     |
| `info`   | Optional: API fields not yet mapped in resource output                      |

### Step 8: Smoke test auth

If the user has API credentials available, run:

```bash
dogsled extract test-auth <name>
```

All resources should return 200. If failures occur:

- Check `integration.yml` auth config `${{ env.* }}` references match the actual env var names
- Verify env vars match `meta.yml` `auth_setup` entries
- Confirm API endpoints are correct and accessible

If no credentials are available, note that and move on.

### Step 9: Run tests

```bash
pnpm --filter @bobsled-inc/integrations test
```

All tests must pass. Fix any failures before proceeding.

### Step 10: Report

Print a summary:

```
Added integration: <name>
  Display name: <display_name>
  Category: <category>
  Resources: <count> (<list of names>)
  Auth: <env var names>
```

{{include: packages/extractor/docs/incremental-cursors-reference.md}}

## Quality Requirements

- Zero `# REVIEW:` annotations in final files
- Every resource has `extract.table.primary_key`
- Every resource has ≥1 output field
- All URLs use HTTPS
- `integration` field in each resource matches the directory name
- No duplicate endpoints within an integration
- Child endpoints must have `for_each` wired to their parent resource
- Resources with a usable cursor parameter declare `extract.incremental`, and
  `cursor_field` references an output field
- All integration tests pass after adding

## Categories

| Category          | Examples                                          |
| ----------------- | ------------------------------------------------- |
| `developer-tools` | GitHub, GitLab, Bitbucket, Jira, Linear, CircleCI |
| `crm`             | Salesforce, HubSpot, Pipedrive, Close             |
| `marketing`       | Mailchimp, Sendgrid, Brevo, ActiveCampaign        |
| `finance`         | Stripe, QuickBooks, Xero, Plaid                   |
| `communication`   | Slack, Discord, Twilio, Intercom                  |
| `analytics`       | Google Analytics, Mixpanel, Amplitude, PostHog    |
| `cloud-infra`     | AWS, GCP, Azure, Datadog                          |
| `productivity`    | Notion, Airtable, Google Sheets, Asana            |
