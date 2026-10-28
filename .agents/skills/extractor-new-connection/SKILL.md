---
name: extractor-new-connection
description: Step-by-step workflow for creating new extractor API connections and resources. Use when adding a new API, creating extractor connection YAML, or extracting data from a new API endpoint.
---

# New Extractor Connection

This skill guides you through creating a new API connection and its resource specs for the `@bobsled-inc/extractor` CLI. Load the `extractor` skill first for full schema reference.

## Prerequisites

- API documentation for the target API
- Authentication credentials (stored as environment variables)
- The `@bobsled-inc/extractor` CLI installed (`dogsled extract`)

## Step 1: Gather API Information

Before writing YAML, collect:

- **Base URL**: The API's HTTPS origin (e.g., `https://api.example.com`) -- no path segments
- **Auth mechanism**: Which auth type applies: `bearer_token`, `basic`, `api_key`, `oauth_client_credentials`, `none`
- **Pagination strategy**: How the API paginates: `link_header`, `cursor`, `offset`, `page_number`, `next_url`, `none`
- **Rate limits**: Documented rate limits (default: 10 req/s, burst 20)
- **Target endpoints**: Which API endpoints to extract from
- **Response format**: Where records live in the JSON response (JSONPath)

## Step 2: Create the Connection Spec

Create `connections/{name}.yml`:

```yaml
spec_version: '1'
name: { api_name } # lowercase_snake_case, must match [a-z][a-z0-9_]*
type: connection
auth_env_vars: [API_TOKEN]
base_url: https://api.example.com # HTTPS origin only, NO path
auth:
  type: bearer_token # Choose from 5 auth types
  token_env: API_TOKEN # UPPERCASE env var name -- NEVER hardcode secrets
pagination:
  type: link_header # Choose from 6 pagination types
```

Key rules:

- `base_url` must be HTTPS with no path (e.g., `https://api.example.com`, NOT `https://api.example.com/v1`)
- Move any API versioning prefix to resource `endpoint` fields
- All `*_env` fields must match `^[A-Z][A-Z0-9_]*$`
- NEVER put actual secrets or tokens in the YAML file

Auth type fields:

- `bearer_token`: `token_env`
- `basic`: `username_env`, `password_env`
- `api_key`: `key_env`, `header` (default: `X-API-Key`)
- `oauth_client_credentials`: `client_id_env`, `client_secret_env`, `token_url` (must be HTTPS)
- `none`: no additional fields

## Step 3: Create Resource Specs

For each API endpoint, create `connections/{name}/{resource}.yml`:

```yaml
spec_version: '1'
name: { resource_name } # lowercase_snake_case
type: resource
connection: { api_name } # Must match connection name exactly
endpoint: /v1/items # Starts with /, include version prefix here
method: GET # GET or POST
params: # Query parameters
  per_page: 100
variables: # URL template variables (for {curly_brace} placeholders)
  org: my-org
response:
  record_path: '$' # JSONPath to array of records (e.g., '$.data', '$.results')
schema:
  columns:
    - name: id
      type: integer
      primary_key: true
    - name: name
      type: string
    - name: created_at
      type: timestamp
```

For each resource:

1. Determine the endpoint path (relative to `base_url`)
2. Identify URL template variables (wrapped in `{curly_braces}`)
3. Set query parameters for pagination and filtering
4. Define `record_path` if records are nested (e.g., `$.data.items`)
5. Define schema columns -- at minimum an `id` (primary_key) and relevant fields
6. Use `path` on columns for nested JSON fields (e.g., `path: '$.user.login'`)
7. Column types: `integer`, `string`, `timestamp`, `boolean`, `number`, `array`, `object`

## Step 4: Add Incremental Config (Optional)

If the API supports filtering by a date or cursor field:

```yaml
incremental:
  cursor_field: updated_at # Must match a column name exactly
  cursor_param: since # Query parameter name the API uses
  cursor_type: timestamp # timestamp | integer | string (optional, auto-detected)
```

The `cursor_field` MUST be listed in `schema.columns`. The extractor tracks the highest value and passes it as the `cursor_param` query parameter on subsequent runs.

## Step 5: Validate

```bash
dogsled extract validate --connection {name} --format json
```

Fix any errors. If `--check-env` flag is used, also verifies that referenced env vars are set.

## Step 6: Test Extraction

```bash
# Quick test with record limit
dogsled extract run --connection {name} --limit 5

# Probe API connectivity (if credentials are available)
dogsled extract discover --connection {name} --probe

# Test a single resource
dogsled extract run --connection {name} --resource {resource} --limit 5
```

## Guardrails Checklist

Before completing, verify:

- [ ] `base_url` is HTTPS origin only (no path segments)
- [ ] All secrets use `*_env` fields (no hardcoded values)
- [ ] All names are lowercase*snake_case matching `^[a-z]a-z0-9*]\*$`
- [ ] Endpoints start with `/`
- [ ] `cursor_field` references an existing column name
- [ ] No duplicate column names within a resource
- [ ] `validate` passes with no errors
