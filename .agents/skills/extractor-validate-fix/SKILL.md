---
name: extractor-validate-fix
description: Validate extractor YAML configs and auto-fix common errors. Use when encountering validation errors, fixing broken configs, or debugging YAML issues.
---

# Extractor Validate & Fix

Diagnose and fix extractor YAML validation errors using the `bobsled extract validate` command and structured error output.

## Step 1: Run Validation

```bash
# Validate all configs
bobsled extract validate --format json

# Validate a specific connection
bobsled extract validate --connection {name} --format json

# Also check env vars
bobsled extract validate --connection {name} --format json --check-env
```

The `--format json` flag outputs structured errors that are easier to parse programmatically.

## Step 2: Identify and Fix Errors

| Error Pattern                                       | Cause                                                                                   | Auto-Fix                                                                                          |
| --------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `Must be lowercase snake_case`                      | Name uses camelCase or uppercase                                                        | Rename `name` field to match `/^[a-z][a-z0-9_]*$/`                                                |
| `base_url must be an HTTPS origin with no path`     | Path included in `base_url`                                                             | Split: move path segment to `endpoint` prefix                                                     |
| `Unrecognized key(s)`                               | Typo or camelCase key                                                                   | Check normalize alias map -- if camelCase of a known key, rename to snake_case. Otherwise remove. |
| `cursor_field "X" must be a column name`            | `cursor_field` references a non-existent column                                         | Either add the missing column to `schema.columns` or fix the `cursor_field` reference             |
| `Duplicate column name "X"`                         | Two columns with the same `name`                                                        | Remove the duplicate column entry                                                                 |
| `Must be an uppercase env var name`                 | Env var not in `/^[A-Z][A-Z0-9_]*$/` format                                             | Rename to `UPPER_CASE`                                                                            |
| `Cannot override restricted HTTP headers`           | Setting `host`, `content-length`, `transfer-encoding`, `connection`, or `authorization` | Remove the restricted header -- use `auth` config instead of `authorization` header               |
| `Endpoint must be a relative path starting with /`  | Missing leading `/` or absolute URL in endpoint                                         | Add leading `/`; if absolute URL, extract path only                                               |
| `base_url must use HTTPS`                           | HTTP URL used                                                                           | Change to `https://`                                                                              |
| `OAuth token_url must use HTTPS`                    | HTTP OAuth token URL                                                                    | Change to `https://`                                                                              |
| `Header values must not contain control characters` | Control chars in header value                                                           | Remove control characters from header values                                                      |
| `spec_version` mismatch                             | Wrong version string                                                                    | Set to `'1'`                                                                                      |
| `type` mismatch                                     | Wrong type value                                                                        | Set to `'connection'` or `'resource'`                                                             |

## Step 3: Re-Validate

After applying fixes, re-run validation:

```bash
bobsled extract validate --connection {name} --format json
```

Repeat Steps 2-3 until no errors remain.

## Step 4: Check Environment Variables (Optional)

With `--check-env`, validation also checks that all referenced `*_env` variables are set in the environment:

```bash
bobsled extract validate --connection {name} --format json --check-env
```

If env vars are missing, generate a `.env.example` snippet:

```bash
# Required env vars for {connection_name}
GITHUB_TOKEN=
# API_KEY=
```

## Normalization Aliases

The extractor auto-normalizes these camelCase keys before validation. If you see "Unrecognized key" for a camelCase variant, it should already be handled -- but always write snake_case:

Common aliases: `specVersion` -> `spec_version`, `baseUrl` -> `base_url`, `tokenEnv` -> `token_env`, `rateLimit` -> `rate_limit`, `cursorField` -> `cursor_field`, `cursorParam` -> `cursor_param`, `primaryKey` -> `primary_key`, `recordPath` -> `record_path`

Full list: see the `extractor` reference skill.
