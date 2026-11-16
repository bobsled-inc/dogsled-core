---
name: extractor
description: YAML-driven API data extraction CLI. Use when writing extractor YAML configs, using the bobsled extract CLI, or doing API data extraction work.
---

# Bobsled Core Extractor — API Data Extraction Reference

Declare API connections and resources in YAML, then extract structured data with a single CLI command.

## Quick Reference

```bash
bobsled extract init [dir]                                # Scaffold new project
bobsled extract validate [target]                         # Validate YAML specs + input completeness
bobsled extract validate --integration github             # Validate single integration
bobsled extract validate --format json                    # Machine-readable output
bobsled extract validate --check-env                      # Also check env vars exist
bobsled extract check <integration>                       # Diff YAML against OpenAPI spec (uses meta.yml openapi_url)
bobsled extract check <integration> --openapi <url>       # Diff against specific OpenAPI spec URL or file
bobsled extract check <integration> --severity warn       # Only show warnings and errors
bobsled extract check <integration> --format json         # Machine-readable output
bobsled extract discover --integration github             # List resources
bobsled extract discover --integration github --probe     # Probe API for schema
bobsled extract run --integration github                  # Full extraction preview
bobsled extract run issues --integration github           # Single resource
bobsled extract run issues --integration github --limit 5 # Limit records
bobsled extract run issues --integration github --advance-state # Persist bookmark
bobsled extract run issues --integration github --full-refresh  # Ignore saved state for this run
bobsled extract lookup --integration github --resource issues --input id=42  # Single record
bobsled extract topup --integration github --resource issues --since 2024-01-01 # Incremental from date
```

Global flags: `-v/--verbose`, `-q/--quiet`, `--log-format <json|pretty>`

## Project Structure

```text
my-project/
├── extractor.yml          # Optional project config
├── integrations/
│   └── github/
│       └── integration.yml
├── resources/
│   └── github/
│       ├── issues.yml
│       └── repos.yml
└── .extractor/
    └── state.json         # Incremental bookmarks (auto-managed)
```

## Connection Spec Schema

Connections declare an API endpoint with auth, rate limiting, and pagination.

```yaml
spec_version: '1' # Required, must be '1'
name: github # Required, lowercase snake_case /^[a-z][a-z0-9_]*$/
type: connection # Required, must be 'connection'
auth_env_vars: [GITHUB_READ_TOKEN]
base_url: https://api.github.com # Required, HTTPS origin only (no path)
auth: # Required (see Auth Types)
  type: bearer_token
  token_env: GITHUB_READ_TOKEN
rate_limit: # Optional (defaults shown)
  requests_per_second: 10
  burst: 20
  retry_on: [429, 503]
  max_retries: 3
  backoff: exponential # exponential | fixed
  retry_after_header: true
pagination: # Optional (see Pagination Types)
  type: link_header
headers: # Optional, custom static headers
  Accept: application/vnd.github.v3+json
```

## Auth Types

| Type                       | Required Fields                                     | Notes                        |
| -------------------------- | --------------------------------------------------- | ---------------------------- |
| `bearer_token`             | `token_env`                                         | Env var holding Bearer token |
| `basic`                    | `username_env`, `password_env`                      | HTTP Basic auth              |
| `api_key`                  | `key_env`, optional `header` (default: `X-API-Key`) | Custom header auth           |
| `oauth_client_credentials` | `client_id_env`, `client_secret_env`, `token_url`   | `token_url` must be HTTPS    |
| `none`                     | (none)                                              | Public APIs                  |

All `*_env` fields must be uppercase env var names matching `/^[A-Z][A-Z0-9_]*$/`.

## Pagination Types

| Type          | Required Fields                                                                                         | Notes                      |
| ------------- | ------------------------------------------------------------------------------------------------------- | -------------------------- |
| `link_header` | (none)                                                                                                  | RFC 5988 Link header       |
| `cursor`      | `cursor_path`, `cursor_param`                                                                           | JSON path to next cursor   |
| `offset`      | `offset_param` (default: `'offset'`), `limit_param` (default: `'limit'`), optional `total_path`         | Offset-based               |
| `page_number` | `page_param` (default: `'page'`), `per_page_param` (default: `'per_page'`), optional `total_pages_path` | Page number                |
| `next_url`    | `next_url_path`                                                                                         | JSON path to next page URL |
| `none`        | (none)                                                                                                  | No pagination              |

## Resource Spec Schema

Resources declare an API endpoint to extract data from.

```yaml
spec_version: '1' # Required, must be '1'
name: issues # Required, lowercase snake_case
type: resource # Required, must be 'resource'
connection: github # Required, connection name
endpoint: /repos/{owner}/{repo}/issues # Required, starts with /
method: GET # Optional, GET | POST (default: GET)
params: # Optional, query parameters
  state: all
  per_page: 100
headers: # Optional, request-level headers
  Accept: application/json
body: {} # Optional, for POST requests
variables: # Optional, URL template variables
  owner: bobsled-inc
  repo: demo-repo
response: # Optional
  record_path: '$' # JSONPath to records (default: '$')
lookup: # Optional, single-record endpoint
  endpoint: /repos/{owner}/{repo}/issues/{id}
  method: GET
  id_variable: id
batch: # Optional
  enabled: false
  max_records: 10000 # 1 to 1,000,000
  compression: none # none | gzip
incremental: # Optional, cursor config
  cursor_field: updated_at # Must match a column name
  cursor_param: since
  cursor_type: timestamp # timestamp | integer | string (auto-detected if omitted)
schema:
  columns: # Required, min 1
    - name: id
      type: integer
      primary_key: true
    - name: title
      type: string
    - name: user_login
      type: string
      path: '$.user.login' # JSONPath for nested fields
  semantic: # Optional
    trust_tier: bronze # bronze | silver | gold
```

## Column Types

| Type        | Description       |
| ----------- | ----------------- |
| `string`    | Text values       |
| `integer`   | Whole numbers     |
| `number`    | Decimal numbers   |
| `boolean`   | true/false        |
| `timestamp` | ISO 8601 datetime |
| `array`     | JSON arrays       |
| `object`    | JSON objects      |

## Validation Rules

| Rule           | Constraint                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------- |
| `name`         | Lowercase snake*case: `/^[a-z]a-z0-9*]\*$/`                                                         |
| `spec_version` | Must be `'1'`                                                                                       |
| `type`         | Must be `'connection'` or `'resource'`                                                              |
| `base_url`     | HTTPS origin only, no path (e.g., `https://api.example.com`)                                        |
| `endpoint`     | Must start with `/`                                                                                 |
| `cursor_field` | Must match an existing column name                                                                  |
| Columns        | No duplicate names                                                                                  |
| `*_env` fields | Uppercase: `/^[A-Z][A-Z0-9_]*$/`                                                                    |
| Headers        | No restricted headers: `host`, `content-length`, `transfer-encoding`, `connection`, `authorization` |
| Header names   | Must match `/^[A-Za-z][A-Za-z0-9-]*$/`                                                              |
| Header values  | No control characters                                                                               |
| `.strict()`    | Unknown keys are rejected                                                                           |

## Security Rules

- **HTTPS only**: `base_url` and `token_url` must use HTTPS
- **Env var indirection**: Never put secrets in YAML — use `*_env` fields
- **SSRF protection**: Runtime checks `url.origin === baseOrigin` on every request
- **Restricted headers**: Cannot set `host`, `content-length`, `transfer-encoding`, `connection`, `authorization`
- **Header injection**: Header names must be alphanumeric + hyphens, values must not contain control characters
- **File size**: YAML specs capped at 1 MB
- **Retry-After cap**: Rate limiter caps server delays at 5 minutes

## Examples

### Connection

```yaml
spec_version: '1'
name: github
type: connection
auth_env_vars: [GITHUB_READ_TOKEN]
base_url: https://api.github.com
auth:
  type: bearer_token
  token_env: GITHUB_READ_TOKEN
rate_limit:
  requests_per_second: 10
  burst: 20
  retry_on: [429, 503]
  max_retries: 3
  backoff: exponential
  retry_after_header: true
pagination:
  type: link_header
headers:
  Accept: application/vnd.github.v3+json
  User-Agent: bobsled-core-extractor/0.1
```

### Resource (with incremental sync)

```yaml
spec_version: '1'
name: issues
type: resource
connection: github
endpoint: /repos/{owner}/{repo}/issues
lookup:
  endpoint: /repos/{owner}/{repo}/issues/{id}
  method: GET
  id_variable: id
method: GET
params:
  state: all
  per_page: 100
variables:
  owner: bobsled-inc
  repo: demo-repo
response:
  record_path: '$'
incremental:
  cursor_field: updated_at
  cursor_param: since
schema:
  columns:
    - name: id
      type: integer
      primary_key: true
    - name: title
      type: string
    - name: state
      type: string
    - name: created_at
      type: timestamp
    - name: updated_at
      type: timestamp
    - name: user_login
      type: string
      path: '$.user.login'
  semantic:
    trust_tier: bronze
```

### Resource (simple list)

```yaml
spec_version: '1'
name: repos
type: resource
connection: github
endpoint: /orgs/{org}/repos
method: GET
params:
  per_page: 100
variables:
  org: bobsled-inc
response:
  record_path: '$'
schema:
  columns:
    - name: id
      type: integer
      primary_key: true
    - name: name
      type: string
    - name: full_name
      type: string
    - name: private
      type: boolean
    - name: created_at
      type: timestamp
    - name: updated_at
      type: timestamp
    - name: owner_login
      type: string
      path: '$.owner.login'
```

## Common Patterns

### Correct

```yaml
# HTTPS base_url with no path
base_url: https://api.github.com

# Secrets via env var indirection
auth_env_vars: [GITHUB_READ_TOKEN]
auth:
  type: bearer_token
  token_env: GITHUB_READ_TOKEN

# Endpoint as relative path
endpoint: /repos/{owner}/{repo}/issues

# Nested field extraction with JSONPath
schema:
  columns:
    - name: user_login
      type: string
      path: '$.user.login'

# Incremental cursor matching a column name
incremental:
  cursor_field: updated_at
  cursor_param: since
```

### Incorrect

```yaml
# Path included in base_url
base_url: https://api.github.com/v3
# ^ Move /v3 to the endpoint field

# Secret hardcoded in YAML
auth:
  type: bearer_token
  token_env: <NOT_AN_ENV_VAR>
# ^ Must be an env var name like GITHUB_READ_TOKEN, not the secret itself

# Missing leading slash on endpoint
endpoint: repos/{owner}/{repo}/issues
# ^ Must start with /

# camelCase name
name: myConnection
# ^ Must be lowercase snake_case: my_connection

# cursor_field not matching any column
incremental:
  cursor_field: modified_at
schema:
  columns:
    - name: updated_at
      type: timestamp
# ^ cursor_field "modified_at" must match a column name

# Restricted header
headers:
  Authorization: Bearer token
# ^ Cannot override authorization; use auth config instead

# HTTP base_url
base_url: http://api.example.com
# ^ Must use HTTPS
```

## Normalization

The extractor auto-normalizes common camelCase keys to snake_case before validation. Always write snake_case, but these aliases are handled:

`specVersion` -> `spec_version`, `baseUrl` -> `base_url`, `tokenEnv` -> `token_env`, `usernameEnv` -> `username_env`, `passwordEnv` -> `password_env`, `keyEnv` -> `key_env`, `clientIdEnv` -> `client_id_env`, `clientSecretEnv` -> `client_secret_env`, `tokenUrl` -> `token_url`, `rateLimit` -> `rate_limit`, `requestsPerSecond` -> `requests_per_second`, `retryOn` -> `retry_on`, `maxRetries` -> `max_retries`, `retryAfterHeader` -> `retry_after_header`, `cursorPath` -> `cursor_path`, `cursorParam` -> `cursor_param`, `offsetParam` -> `offset_param`, `limitParam` -> `limit_param`, `totalPath` -> `total_path`, `pageParam` -> `page_param`, `perPageParam` -> `per_page_param`, `totalPagesPath` -> `total_pages_path`, `nextUrlPath` -> `next_url_path`, `maxRecords` -> `max_records`, `batchDir` -> `batch_dir`, `primaryKey` -> `primary_key`, `cursorField` -> `cursor_field`, `cursorType` -> `cursor_type`, `recordPath` -> `record_path`, `idVariable` -> `id_variable`, `sourceType` -> `source_type`, `trustTier` -> `trust_tier`

## Troubleshooting

| Error                                              | Cause                                 | Fix                              |
| -------------------------------------------------- | ------------------------------------- | -------------------------------- |
| `Must be lowercase snake_case`                     | Name uses camelCase or uppercase      | Rename to `lowercase_snake_case` |
| `base_url must be an HTTPS origin with no path`    | Path included in base_url             | Move path prefix to `endpoint`   |
| `Endpoint must be a relative path starting with /` | Missing leading `/` or absolute URL   | Start endpoint with `/`          |
| `Unrecognized key(s)`                              | Typo or camelCase key                 | Check alias map; use snake_case  |
| `cursor_field "X" must be a column name`           | cursor_field doesn't match any column | Add column or fix reference      |
| `Duplicate column name "X"`                        | Two columns with same name            | Remove duplicate                 |
| `Must be an uppercase env var name`                | Env var not uppercase                 | Use `UPPER_CASE_NAME`            |
| `Cannot override restricted HTTP headers`          | Setting host/content-length/etc       | Remove restricted header         |
| `base_url must use HTTPS`                          | HTTP URL used                         | Switch to `https://`             |
| `OAuth token_url must use HTTPS`                   | HTTP token URL                        | Switch to `https://`             |
