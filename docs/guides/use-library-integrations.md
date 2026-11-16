# Use library integrations

Bobsled Core ships 83 ready-made integrations for common APIs. Each one is an
integration file plus a set of resources, already mapped to typed columns, and
each lists the environment variables it needs. This guide shows how to find one,
run it, and copy it into your project when you want to change it. The full list is
in the [connector reference](../reference/connectors.md#library-integrations).

## Find an integration

```bash
bobsled integrations list --category finance
```

```text
brex         api   finance   6 resources
chargebee    api   finance   10 resources
quickbooks   api   finance   8 resources
recurly      api   finance   5 resources
stripe       api   finance   25 resources
xero         api   finance   6 resources
zuora        api   finance   6 resources
```

`--type` filters by `api`, `mcp` or `db`, and `--json` prints the full records.

Show an integration's resources and the credentials it needs:

```bash
bobsled integrations show github
```

```text
GitHub
──────
Category: developer-tools
...
Resources:
...
issues               Issues for a GitHub repository including bug reports, feature requests, and tasks with full metadata
...
Auth setup:
GITHUB_TOKEN — Personal access token or GitHub App token
```

Show one resource, with its endpoint and columns:

```bash
bobsled integrations show github issues
```

```text
Resource: issues
Integration: github
...
Endpoint: GET /repos/${{ input.owner }}/${{ input.repo }}/issues
```

## Run it

Library integrations are built into the CLI, so you can run them without copying
any files. Set the credential the integration asks for, and pass the resource's
inputs with `--input`. In the GitHub integration, `issues` runs once for every
repository that `repos` returns, so you select both:

```bash
export GITHUB_TOKEN=<your token>
bobsled extract run --integration github repos issues --input org=octo-org --quiet \
  | bobsled load run --dest duckdb --db-path github.duckdb
bobsled query "SELECT repository_full_name, count(*) AS issues FROM issues GROUP BY 1 ORDER BY 1" \
  --db-path github.duckdb
```

```text
[loader] repos: loaded 4 rows
[loader] issues: loaded 13 rows
repository_full_name	issues
octo-org/hello-world-javascript-action	2
octo-org/octo-repo-go	4
...
```

`octo-org` is a public demo organization on GitHub, so its numbers can change.

To check an integration without credentials or network access, run its recorded
fixtures through the extractor:

```bash
bobsled extract verify github --mock
```

```text
Verification Results
...
github  (19 resources, 19 mock resources, 19 mock fixtures, 0 errors
```

## Customize it

`bobsled integrations init` copies the integration and the resources you choose
into your project:

```bash
bobsled integrations init github --resources repos,issues
```

```text
Created integrations/github.yml
Created resources/github/repos.yml
Created resources/github/issues.yml
...
Required environment variables:
GITHUB_TOKEN — Personal access token or GitHub App token
```

A file in your project takes the place of the built-in file with the same name, so
you can edit the copied resources: drop columns, change defaults, or add
incremental settings. Resources you did not copy still come from the library.

Run `bobsled extract validate github` after editing.

## Generate an integration from OpenAPI

If an API publishes an OpenAPI document, `bobsled extract generate` writes an
integration and one resource per `GET` endpoint. It reads a local file or an HTTPS
URL. For a small fictional inventory API:

Create `openapi.yaml`:

```yaml
openapi: 3.0.3
info:
  title: Inventory API
  version: '1.0'
servers:
  - url: https://api.example.com/v1
components:
  securitySchemes:
    apiKey:
      type: apiKey
      in: header
      name: X-API-Key
security:
  - apiKey: []
paths:
  /products:
    get:
      operationId: listProducts
      parameters:
        - { name: page, in: query, schema: { type: integer } }
      responses:
        '200':
          description: Products
          content:
            application/json:
              schema:
                type: array
                items:
                  type: object
                  properties:
                    id: { type: integer }
                    name: { type: string }
                    price: { type: number }
                    updated_at: { type: string, format: date-time }
```

```bash
bobsled extract generate openapi.yaml --integration inventory
bobsled extract validate inventory
```

```text
Integration: integrations/inventory.yml
Resources: 1 files
resources/inventory/list_products.yml /products
...
Validated 2 spec(s) successfully
```

The generated integration uses `api-key` auth with the header from the
`securitySchemes`, reading the key from `INVENTORY_API_KEY`. The resource maps each
response property to a typed column and detects page-number pagination from the
`page` parameter. Lines that need a human decision are marked `# REVIEW:`.
`--tags` limits generation to tagged operations, and `--dry-run` prints the YAML
instead of writing files.

Later, `bobsled extract check inventory --openapi openapi.yaml` compares your edited
files with a newer version of the document and reports drift.

## Request a new integration

If an API you need is missing, open a connector request in
[GitHub Discussions](https://github.com/bobsled-inc/bobsled-core/discussions/new?category=connector-requests)
with the API, its authentication type, the objects you need and a synthetic
response sample.
