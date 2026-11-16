# Query data

Dogsled can query the tables you loaded, query an API as if it were a table, and
run verified queries by name. The examples continue the `shop` project from
[Get started](../getting-started.md) and [Build models](build-models.md).

## Query a database

`dogsled query` runs SQL against a DuckDB file or a BigQuery dataset:

```bash
dogsled query "SELECT customer, total_amount FROM analytics.customer_revenue ORDER BY total_amount DESC" \
  --db-path .bobsled/bobsled.duckdb
```

```text
customer	total_amount
linus	300
ada	162.75
grace	95.75
```

In a terminal the result is tab-separated. When the output goes to a pipe, a file
or a CI job, it is JSON; `--yaml` prints YAML. For BigQuery, pass `--dest bigquery`
with `--project-id`, `--dataset-id` and optionally `--location` and
`--key-filename`. `dogsled load query` is the same command.

## Query an API as a table

`dogsled source-query` runs SQL over `sources.<name>`, where each name is an
API-backed source. Dogsled fetches the API when the query needs it, loads the rows
into DuckDB, and runs the query there.

An API-backed source needs a resource with a `query` block, which lists the filters
the API accepts and binds them to the resource's inputs. Replace the users resource
from Get started.

Create `resources/jsonplaceholder/users.yml`:

```yaml
spec_version: '1'
type: resource
name: users
description: Fictional users from the JSONPlaceholder test API.
integration: jsonplaceholder
api:
  endpoint: /users
  method: GET
input:
  id: { type: integer }
query:
  filters:
    id:
      operators: [eq]
      bind:
        eq: { input: id }
output:
  id: { type: integer, path: $.id }
  name: { type: string, path: $.name }
  email: { type: string, path: $.email }
  city: { type: string, path: $.address.city }
extract:
  record_path: $
  table:
    primary_key: [id]
```

Create `sources/users.yml`. `connection` is the model integration whose DuckDB
file caches the rows:

```yaml
spec_version: '0.2'
type: source
name: users
source_type: api_resource
integration: jsonplaceholder
resource: users
connection: warehouse
mode: lazy
schema:
  columns:
    - { name: id, type: INTEGER }
    - { name: name, type: STRING }
    - { name: email, type: STRING }
    - { name: city, type: STRING }
```

```bash
dogsled source-query "SELECT city, count(*) AS users FROM sources.users GROUP BY city ORDER BY city LIMIT 3"
```

```text
source=users target=duckdb table=bronze.users
{"city":"Aliyaview","users":1}
{"city":"Bartholomebury","users":1}
{"city":"Gwenborough","users":1}
```

The first line goes to standard error and describes what Dogsled did: here it
fetched 10 records and stored them (`action=materialized`).

`mode` controls the cache:

- `live` fetches on every query and keeps nothing.
- `lazy` stores the rows and reuses them on later queries (`action=reused`). Set
  `max_age`, for example `1h`, to refetch older rows.
- `extract` never calls the API. It reads the table that a pipeline already loaded
  into the destination, and fails if the table is missing.

Lazy sources are stored in the destination named in `.bobsled/config.yml`:
DuckDB, DuckLake, Snowflake or BigQuery. `dogsled init` writes this file and uses the
`bronze` schema.

## Run a verified query

A verified query pairs a question with SQL that answers it and declares typed
parameters. Refer to an API-backed source as `{<integration>.<source>}` and to a
parameter as `{<name>}`. Dogsled checks each value against its type and escapes it.

Create `vqs/users_in_city.yml`:

```yaml
spec_version: '0.2'
type: vq
name: users_in_city
nlq: Which users live in a given city?
sql: SELECT id, name FROM {jsonplaceholder.users} WHERE city = {city} ORDER BY id
parameters:
  - name: city
    type: string
```

```bash
dogsled vq users_in_city --param city=Gwenborough
```

```text
...
{"id":"1","name":"Leanne Graham"}
```

A missing or invalid parameter stops the query with exit code 2:

```bash
dogsled vq users_in_city || echo "exit code $?"
```

```text
✗ missing required VQ parameter "city"
exit code 2
```

`--session name=value` passes session context, and `--vqs-dir` limits the search
to one folder. In this release, verified queries run over API-backed sources only.
