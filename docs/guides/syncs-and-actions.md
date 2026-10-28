# Send data to other systems

Dogsled can also write outward: an _action_ is one call to another system, such as
a webhook or an API request, and a _sync_ runs an action for every new row of a
warehouse table, remembering where it stopped.

## Actions

An action file declares the request and its typed inputs. This one posts a contact
to a webhook.

Create `actions/notify_contact.yml`:

```yaml
spec_version: '1'
type: action
transport: webhook
integration: webhook
name: notify_contact
tags: [example, contacts]
description: Send a contact row to an HTTPS webhook endpoint.
webhook:
  url: https://hooks.example.com/contacts
  method: POST
  request_body:
    email: ${{ input.email }}
    first_name: ${{ input.first_name }}
    last_name: ${{ input.last_name }}
input:
  email:
    type: string
    required: true
  first_name:
    type: string
  last_name:
    type: string
    required: true
```

An action is named `<integration>/<name>`, here `webhook/notify_contact`. The
library integrations also ship actions, for example `hubspot/create_note`. List,
inspect and call them with `dogsled act`:

```bash
dogsled act --list --tag example
dogsled act webhook/notify_contact --input email=ada@example.com --input last_name=Lovelace --dry-run
```

```text
Name                    Transport  Integration  Tags               Required Inputs
webhook/notify_contact  webhook    webhook      example, contacts  email, last_name
{
"status": "skipped",
"action": "webhook/notify_contact",
...
"preview": {
"operation": "POST",
"target_host": "hooks.example.com",
...
```

`--dry-run` builds and checks the request and prints a preview without sending it.
Without it, the call is made and the result has `"status": "success"`. `--describe` prints an action's inputs, and
`--input-json` passes inputs as one JSON object.

## Syncs

A sync reads new rows from a table or view (a _projection_) in cursor order, maps
each row to an action's inputs, and calls the action. It keeps a checkpoint, a
receipt per row and the failed rows under `.dogsled/sync-state/<sync>/`.

The examples use a DuckDB file with a projection of contacts that are ready to
send:

Create `integrations/duckdb.yml`:

```yaml
spec_version: '1'
type: integration
name: duckdb
source_type: duckdb
connection:
  schema: main
auth:
  type: file
  path: demo.db
```

```bash
dogsled query "CREATE TABLE main.contacts_to_webhook_projection AS SELECT * FROM (VALUES ('e1','ada@example.com','Ada','Lovelace','eligible', TIMESTAMP '2026-01-01 10:00:00'), ('e2','grace@example.com','Grace','Hopper','eligible', TIMESTAMP '2026-01-02 10:00:00'), ('e3','linus@example.com','Linus','T','blocked', TIMESTAMP '2026-01-03 10:00:00')) t(entity_id, email, first_name, last_name, readiness_status, observed_at)" \
  --db-path demo.db
```

Create `syncs/contacts_to_webhook.yml`:

```yaml
spec_version: '1'
type: sync
name: contacts_to_webhook
description: Push eligible contact projection rows to a webhook action.
source:
  type: projection
  connection: duckdb
  projection_ref: main.contacts_to_webhook_projection
  cursor:
    field: observed_at
    tie_breaker_fields: [entity_id]
    initial_value: '1970-01-01T00:00:00.000Z'
  filters:
    readiness_status: eligible
target:
  action: webhook/notify_contact
  entity_key:
    fields: [email]
  input_mapping:
    email: email
    first_name: first_name
    last_name: last_name
options:
  state_backend: local
  page_size: 500
  on_record_error: skip
```

```bash
dogsled sync validate contacts_to_webhook
dogsled sync run contacts_to_webhook
```

```text
valid: true
...
status: completed
dry_run: false
counters:
processed: 2
succeeded: 2
failed: 0
skipped: 0
```

Two contacts are eligible, so the webhook receives two requests. A second run sends
nothing, because the checkpoint is past both rows:

```bash
dogsled sync run contacts_to_webhook
cat .dogsled/sync-state/contacts_to_webhook/checkpoint.json
```

```text
processed: 0
...
"cursor_value": "2026-01-02 10:00:00",
```

- `--dry-run` builds every request without sending it or moving the checkpoint.
  `--limit` caps the rows processed.
- Each action call is at least once: if a run stops between the call and the
  checkpoint, the next run repeats that call. `entity_key` identifies the record in
  receipts.
- `on_record_error: skip` records a failed row and continues; after
  `consecutive_failure_threshold` failures in a row the run stops.
- Syncs read from DuckDB, PostgreSQL, BigQuery, Snowflake and Databricks. `schedule` is optional metadata
  for your scheduler; Core runs a sync only when you call `dogsled sync run`.

## Entity activation

`dogsled activate` (also `dogsled entity-graph activate`) sends entity-graph
records to an action and records each dispatch in the entity-graph audit log;
`activate receipts` queries those records. `dogsled extract activate` calls an API
action for every `RECORD` it reads on standard input.
