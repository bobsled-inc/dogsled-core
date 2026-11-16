# Run Dogsled in production

Dogsled Core is a command-line tool. It has no server and no scheduler. In
production, a scheduler that you already use starts `dogsled` on a schedule: a
GitHub Actions workflow, cron, a systemd timer, Airflow or a Kubernetes CronJob.
This guide shows how to set that up so that runs are repeatable, keep their
credentials out of your files, and pick up where the last run stopped.

## How Dogsled runs

Each scheduled run is one or more commands, for example:

```bash
npx --no-install dogsled runner validate --strict
npx --no-install dogsled runner run helpdesk_tickets
npx --no-install dogsled model run --integration warehouse --json
```

`runner run` runs one extract pipeline from `bobsled.yml` and exits.
`model run` builds the models on one model integration and exits. Run Dogsled with
`npx --no-install dogsled` in production. Without `--no-install`, npx downloads
and runs a package from the npm registry when Dogsled is not installed in the
folder, and an unrelated npm package is called `dogsled`. A run needs three
things:

- **The project files.** Keep them in a Git repository, for example
  `example-org/my-bobsled-project`, together with a `package.json` and
  `package-lock.json` that pin the Dogsled version.
- **Credentials**, as environment variables. Project files name the variables;
  the scheduler sets their values.
- **Somewhere to keep state** between runs. Incremental resources save a cursor
  after each run, and `model run` records what it built. A fresh CI runner starts
  with no files, so both have to be stored outside the runner. See
  [Keep state between runs](#keep-state-between-runs).

The examples below use the help-desk API integration from
[Extract from an API](extract-from-an-api.md), a BigQuery destination, and a
BigQuery model integration named `warehouse`. `runner run` loads each resource into
a table named `<pipeline>__<stream>`, here `helpdesk_tickets__tickets`, unless the
pipeline sets `table_prefix`; see [Run pipelines](run-pipelines.md#run-it).

### Pin the version

Install Dogsled into the project repository with an exact version, together with
the driver for your warehouse, and commit both npm files:

```bash
npm install --save-exact @bobsled-inc/bobsled-core@<version> @google-cloud/bigquery@<version>
git add package.json package-lock.json
```

`npm ci` then installs exactly what the lockfile lists on every run. Upgrade
Dogsled with a pull request that changes the version, so that the validation job
below checks the project against the new version before it reaches production.
Do not use an unpinned `npx @bobsled-inc/bobsled-core` in production. Other warehouses
need other drivers, for example `snowflake-sdk` for Snowflake; see the
[driver table](load-data.md#install-a-warehouse-driver).

### Declare the secrets

Dogsled reads a credential only from an environment variable that a project file
declares. An integration lists the names it uses in `auth_env_vars`, and a
destination in `bobsled.yml` does the same:

```yaml
spec_version: '1'
type: integration
name: helpdesk
auth_env_vars: [HELPDESK_TOKEN]
transport:
  type: http
  base_url: https://api.example.com/v1
  auth:
    type: bearer
    token: ${{ env.HELPDESK_TOKEN }}
```

The scheduler maps each secret to a variable with the same name. A name that is
not declared is refused. `runner validate --strict` fails on an undeclared name in
an integration. It does not check the names that destinations in `bobsled.yml`
use: `runner run` refuses an undeclared destination name when it starts, with exit
code `2`. Dogsled keeps the values out of its output, logs and state files.
[Environment variables](../reference/environment-variables.md#state-and-credentials)
has the full rules.

An API's `base_url` must use HTTPS. Dogsled refuses loopback and private
addresses, such as an API inside your own network, unless the run sets
`BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS=1`; see
[Network safety](../reference/environment-variables.md#network-safety).

## GitHub Actions

This workflow lives in the project repository at `.github/workflows/bobsled.yml`.
It has two jobs:

- `run` extracts, loads and builds the models every day, and when you start it by
  hand. It is the only job that can read production credentials.
- `validate` checks every pull request. It has no secrets and no cloud access.

```yaml
name: Dogsled

on:
  schedule:
    - cron: '17 6 * * *'
  workflow_dispatch:
  pull_request:

permissions: {}

jobs:
  validate:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0
        with:
          persist-credentials: false
      - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0
        with:
          node-version: 24
      - run: npm ci
      - run: npx --no-install dogsled runner validate --strict
      - run: npx --no-install dogsled extract validate helpdesk
      - run: npx --no-install dogsled model validate --integration warehouse

  run:
    if: github.event_name != 'pull_request'
    runs-on: ubuntu-24.04
    timeout-minutes: 120
    environment: production
    concurrency:
      group: dogsled-production
      cancel-in-progress: false
    permissions:
      contents: read
      id-token: write
    env:
      STATE_PREFIX: gs://example-bobsled-state/my-bobsled-project
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0
        with:
          persist-credentials: false
      - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0
        with:
          node-version: 24
      - run: npm ci
      - name: Check the project
        run: npx --no-install dogsled runner validate --strict
      - name: Sign in to Google Cloud
        uses: google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093 # v3.0.0
        with:
          workload_identity_provider: ${{ vars.GCP_WORKLOAD_IDENTITY_PROVIDER }}
          service_account: ${{ vars.GCP_SERVICE_ACCOUNT }}
      - uses: google-github-actions/setup-gcloud@aa5489c8933f4cc7a4f7d45035b3b1440c9c10db # v3.0.1
      - name: Restore state
        id: restore
        run: |
          mkdir -p .extractor .bobsled/model-spec
          gcloud storage cp "$STATE_PREFIX/state.json" .extractor/state.json
          gcloud storage cp "$STATE_PREFIX/run-state.json" .bobsled/model-spec/run-state.json
      - name: Extract and load
        env:
          HELPDESK_TOKEN: ${{ secrets.HELPDESK_TOKEN }}
        run: npx --no-install dogsled runner run helpdesk_tickets
      - name: Save extraction state
        run: gcloud storage cp .extractor/state.json "$STATE_PREFIX/state.json"
      - name: Build models
        run: npx --no-install dogsled model run --integration warehouse --json
      - name: Save model state
        if: always() && steps.restore.outcome == 'success'
        run: gcloud storage cp .bobsled/model-spec/run-state.json "$STATE_PREFIX/run-state.json"
      - name: Report a failure
        if: failure()
        env:
          ALERT_WEBHOOK_URL: ${{ secrets.ALERT_WEBHOOK_URL }}
        run: |
          run_url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
          curl --fail --silent --show-error -X POST -H 'Content-Type: application/json' \
            --data "{\"text\":\"Dogsled run failed: $run_url\"}" "$ALERT_WEBHOOK_URL"
```

What each part does:

- **Pinned actions.** Every `uses:` names a full commit SHA, with the release in a
  comment. A tag can be moved; a commit cannot. Update the SHAs on purpose, for
  example with Dependabot.
- **Least privilege.** `permissions: {}` removes the default token permissions,
  and each job asks only for what it needs. `id-token: write` lets the `run` job
  request a short-lived token from GitHub to sign in to Google Cloud.
  `persist-credentials: false` keeps the checkout token off the disk.
- **Secrets in one environment.** Create a `production` environment in the
  repository settings, store `HELPDESK_TOKEN` and `ALERT_WEBHOOK_URL` as its
  secrets, and the two Google Cloud names as its variables. Allow only the default
  branch to deploy to it, so a workflow changed in a pull request cannot use it.
  Only the `run` job names the environment, so only it can read them, and each
  secret is given only to the step that uses it.
- **Validation in pull requests.** The `validate` job names no environment and no
  secrets. Validation does not need them: it reads the files and checks the
  declarations, but not the values. Pull requests from forks never receive
  secrets. Never run Dogsled on `pull_request_target`.
- **The installed version.** `npm ci` installs the locked packages, and
  `npx --no-install` runs that copy. It fails instead of downloading another one.
- **No overlapping runs.** The `concurrency` group lets one `run` job work at a
  time. A run that starts while another is working waits; if a third one starts,
  GitHub cancels the one that was waiting. Use the same group in every workflow
  that runs pipelines or models of this project, because they share the state
  files.
- **A time limit.** `timeout-minutes` stops a stuck run. Set it above your
  longest normal run.
- **Validate, then run.** `runner validate --strict` fails on warnings as well as
  errors, before anything is extracted. `runner run` then runs the extract
  pipeline, and `model run` builds the models. `--json` makes `model run` print
  each model's result, including the reason a model failed.

Models pipelines (`type: models`) in `bobsled.yml` are instructions for an
orchestrator. `runner run` does not build them; it exits with code `2` and prints
the `dogsled model run` command to use instead. See
[Run pipelines](run-pipelines.md#models-and-entity-graph-pipelines).

GitHub runs scheduled workflows on the default branch, in UTC, and can start them
late when it is busy. Avoid the start of the hour. In a public repository, GitHub
turns off scheduled workflows after 60 days without activity.

### Short-lived credentials for BigQuery

The `run` job signs in to Google Cloud with Workload Identity Federation, so no
service-account key is stored in GitHub. `google-github-actions/auth` exchanges
GitHub's token for short-lived Google credentials and points Application Default
Credentials at them. Dogsled's BigQuery destination uses Application Default
Credentials when it has no credential fields, and the model integration asks for
them with `auth.type: adc`:

```yaml
destinations:
  bigquery_raw:
    type: bigquery
    project: example-analytics
    dataset: raw
    location: US

pipelines:
  helpdesk_tickets:
    schedule: daily
    source: helpdesk
    destination: bigquery_raw
    resources: [tickets]
```

```yaml
spec_version: '1'
type: integration
name: warehouse
source_type: bigquery
connection:
  project_id: example-analytics
  default_location: US
  dataset: analytics
auth:
  type: adc
```

In Google Cloud, create a workload identity pool and a provider for GitHub, limit
it to your repository with an attribute condition, and let it act as a service
account that can run BigQuery jobs, write the `raw` and `analytics` datasets, and
read and write the state object. The
[`google-github-actions/auth` documentation](https://github.com/google-github-actions/auth#workload-identity-federation-through-a-service-account)
lists the steps.

### Snowflake with a key pair

For Snowflake, use key-pair authentication instead of a password: store the
private key as a secret, write it to a file that only the runner user can read,
and pass the file's path. The destination and the model integration declare the
names they use:

```yaml
destinations:
  snowflake_raw:
    type: snowflake
    account: $SNOWFLAKE_ACCOUNT
    username: $SNOWFLAKE_USER
    private_key_path: $SNOWFLAKE_PRIVATE_KEY_PATH
    role: LOADER
    warehouse: LOAD_WH
    database: ANALYTICS
    schema: RAW
    auth_env_vars: [SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_PRIVATE_KEY_PATH]
```

```yaml
spec_version: '1'
auth_env_vars: [SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_PRIVATE_KEY_PATH]
type: integration
name: warehouse
source_type: snowflake
connection:
  account_identifier: ${{ env.SNOWFLAKE_ACCOUNT }}
  user: ${{ env.SNOWFLAKE_USER }}
  role: TRANSFORMER
  warehouse: TRANSFORM_WH
  database: ANALYTICS
  schema: MARTS
auth:
  type: rsa_key
  private_key_path: ${{ env.SNOWFLAKE_PRIVATE_KEY_PATH }}
```

In the `run` job, replace the Google Cloud sign-in with a step that writes the key,
and set the non-secret names for the whole job:

```yaml
env:
  SNOWFLAKE_ACCOUNT: ${{ vars.SNOWFLAKE_ACCOUNT }}
  SNOWFLAKE_USER: ${{ vars.SNOWFLAKE_USER }}
steps:
  # checkout, setup-node and npm ci as above
  - name: Write the Snowflake key
    env:
      SNOWFLAKE_PRIVATE_KEY: ${{ secrets.SNOWFLAKE_PRIVATE_KEY }}
    run: |
      umask 077
      key_path="$RUNNER_TEMP/snowflake_key.p8"
      printf '%s\n' "$SNOWFLAKE_PRIVATE_KEY" > "$key_path"
      echo "SNOWFLAKE_PRIVATE_KEY_PATH=$key_path" >> "$GITHUB_ENV"
```

The key file sits in the runner's temporary folder, outside the checkout, so it
cannot be committed by mistake. GitHub empties that folder at the end of the job.
If the key is encrypted, add `private_key_passphrase` to both files and declare its
variable too. Install the `snowflake-sdk` driver next to Dogsled, as in
[Pin the version](#pin-the-version). Keep the state files somewhere your runner
can reach, for example S3 with `aws s3 cp` in the same steps as above.

## Keep state between runs

Dogsled keeps two state files in the project folder:

- `.extractor/state.json` holds the extraction cursors.
- `.bobsled/model-spec/run-state.json` records what `model run` built.

A fresh CI runner or container starts without either file, so keep both between
runs.

### Extraction cursors

An incremental resource saves a cursor, such as the highest `updated_at` it has
seen, so the next run asks the source only for changes. By default, `runner run`
saves the cursors of every integration in one file in the project:
`.extractor/state.json`. Set `state_dir` in `extractor.yml` to move it. The file
holds one entry per `<integration>/<stream>`:

```json
{
  "streams": {
    "helpdesk/tickets": {
      "cursor_field": "updated_at",
      "cursor_type": "timestamp",
      "cursor_value": "2026-01-07T00:00:00.000Z",
      "last_run_at": "2026-01-08T06:17:12.000Z",
      "record_count": 7
    }
  }
}
```

Without this file, Dogsled treats every resource as never run: it reads everything
again, and an `append` resource loads duplicate rows.

### Model state

`model run` records each model it builds in `.bobsled/model-spec/run-state.json`:
its materialization, its columns and when it last ran. Without this file, every
model counts as never built:

- an incremental model is rebuilt with `CREATE OR REPLACE` instead of merging new
  rows;
- a snapshot model is rebuilt, so the history it kept is lost;
- a change to a model's columns or materialization is no longer caught, so the
  table is rebuilt instead of the run stopping with exit code `3`.

Agentic models on DuckDB also keep their checkpoints under `.bobsled/model-spec/`.
On a warehouse they keep them in warehouse tables. See
[Agentic models](agentic-models.md#run-and-resume).

Add `node_modules/`, `.extractor/` and `.bobsled/` to `.gitignore`. State does not
belong in the project repository; keep it as described below.

### Recommended: copy the files to object storage

The workflow above restores both files from Cloud Storage before the run. It saves
`state.json` after `runner run` succeeds, and `run-state.json` after `model run`,
whether or not `model run` succeeds. Use any storage that your runner can reach and
that keeps old versions, such as a bucket with object versioning turned on. Create
the objects once, before the first scheduled run:

```bash
echo '{"streams":{}}' > state.json
echo '{"models":{}}' > run-state.json
gcloud storage cp state.json run-state.json gs://example-bobsled-state/my-bobsled-project/
```

The restore step fails if an object is missing, so a run never starts from the
beginning by accident. To start the extraction again on purpose, upload the empty
`state.json` again, or run `runner run --full-refresh` once. To rebuild the
models, run `model run --full-refresh` once.

`model run` writes `run-state.json` for every model that it built, even when
another model fails, and those tables have changed in the warehouse. So the
workflow saves it whenever the restore step worked. It saves `state.json` only when
`runner run` succeeds. That matters for two reasons:

- With one destination, the extractor saves the cursor when extraction finishes,
  even if the load that follows fails. A state file from a failed run can be ahead
  of the data in the warehouse. With several destinations, Dogsled saves the
  cursor only after every destination has loaded.
- If one resource fails, `runner run` fails, but the cursors of the resources that
  succeeded have already moved. Not saving them means the next run reads those
  changes again.

Reading changes again is harmless when the resource has a primary key and loads
with `merge`, the default when `primary_key` is set. Use that for incremental
resources that run on a schedule.

### Alternative: an HTTPS state backend

Dogsled can also read and write the state over HTTPS instead of a local file. Set
two variables on the `runner run` step:

```yaml
- name: Extract and load
  env:
    HELPDESK_TOKEN: ${{ secrets.HELPDESK_TOKEN }}
    BOBSLED_CORE_STATE_BACKEND: https://state.example.com/v1/state/my-bobsled-project
    BOBSLED_CORE_STATE_AUTH_ENV: STATE_TOKEN
    STATE_TOKEN: ${{ secrets.STATE_TOKEN }}
  run: npx --no-install dogsled runner run helpdesk_tickets
```

Dogsled sends `GET` to that URL before extracting and `PUT` with the whole state
after it, with `Authorization: Bearer` and the value of the variable named in
`BOBSLED_CORE_STATE_AUTH_ENV`. The server returns the state as JSON, or `404` if there is
none yet. Dogsled treats `404` as empty state, so a wrong URL makes the run read
everything again rather than fail. It returns an `ETag` header; Dogsled sends it back in `If-Match`, and the
server answers `412` if another run wrote in between. The URL must be a public
HTTPS address unless you set `BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS=1`. Dogsled
Core does not include such a server: you run it yourself. With this backend,
Dogsled saves the cursor itself as described above, so you cannot hold it back
after a failed run. The backend holds only the extraction cursors: keep
`run-state.json` with the copy steps above. Use it when you already have a service
that stores state for your jobs.

### OAuth refresh tokens

Some OAuth providers issue a new refresh token each time Dogsled uses the old one.
For `oauth2` integrations with `grant_type: authorization_code`, Dogsled saves the
new token in `auth-state.json` next to the state file. It does not send it to an
HTTPS state backend. On a fresh runner that file is missing, and Dogsled uses the
refresh token from your secret again. If the provider has already invalidated that
token, the run fails. Run such integrations on a machine that keeps its files, or
check that the provider accepts a refresh token more than once. Never cache, upload
or commit `auth-state.json`: it contains a credential.

## Failures and alerts

A step fails when its command exits with a code other than `0`, and the job stops
there. The `runner` and `model` commands use these exit codes:

| Code | Meaning                                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------ |
| `0`  | Success.                                                                                                                 |
| `1`  | Runtime failure, such as a rejected credential, an API error or a failed load.                                           |
| `2`  | Validation failure, such as an invalid file, an undeclared variable or an unknown pipeline.                              |
| `3`  | Drift. `model run` uses it when a model's columns or materialization changed in a way that it will not apply on its own. |

Other commands differ: `extract validate`, for example, exits with `1` when a file
is invalid. A process stopped by a signal exits with 128 plus the signal number,
such as `143` for `SIGTERM`, and `runner run` can also exit with `143` when a load
fails and it stops the extractor. Treat any non-zero code as a failure. If any
resource in a pipeline fails, `runner run` exits with a non-zero code, after
running the other resources. A `3` from `model run` needs a person. With `--json`,
the failed model's `error` lists the change and the statements that apply it; the
plain-text output only says that the model failed.

Outside a terminal, `runner validate` and `runner run` write JSON lines. The last
line of `runner run` is a `PIPELINE_SUMMARY` with the records extracted and rows
loaded per stream, and an error message for each failed stream:

```text
{"_v":1,"type":"PIPELINE_SUMMARY","integration":"helpdesk","elapsed_seconds":0.5,"total_streams":1,"succeeded":1,"failed":0,"skipped":0,"total_records_extracted":7,"total_rows_loaded":7,...}
```

The logs contain counts, names and error messages, not the rows themselves.
Dogsled does not print credential values, and GitHub also masks the values of the
secrets it passes to a step. Do not add `set -x` or print the environment in a
step that has secrets.

Dogsled Core has no built-in alerts. Use your scheduler's: GitHub notifies the
user who last changed the `schedule` when a scheduled run fails, depending on
their notification settings. The last step of the workflow posts the run's link to
a chat or incident webhook when an earlier step fails. Store the webhook URL as a
secret, because it usually works as a password.

## Other schedulers

The same commands work from any scheduler. Keep the steps in the same order:
validate, restore both state files, run the pipeline, save `state.json` after
success, build the models, save `run-state.json`.

### A server with systemd

On a server that keeps its files between runs, `.extractor/state.json` and
`.bobsled/model-spec/run-state.json` stay on disk, and you do not need to copy
them. Back them up with the rest of the server.

Put the commands in a script in the project, `run-bobsled.sh`:

```sh
#!/bin/sh
set -eu
npx --no-install dogsled runner validate --strict
npx --no-install dogsled runner run helpdesk_tickets
npx --no-install dogsled model run --integration warehouse --json
```

Run it from a systemd service and timer. The credentials live in an environment
file that only the service user can read (`chmod 600`):

```ini
# /etc/systemd/system/dogsled.service
[Unit]
Description=Dogsled pipelines

[Service]
Type=oneshot
User=dogsled
WorkingDirectory=/srv/my-bobsled-project
EnvironmentFile=/etc/dogsled/production.env
ExecStart=/bin/sh run-bobsled.sh
TimeoutStartSec=2h
```

```ini
# /etc/systemd/system/dogsled.timer
[Unit]
Description=Run Dogsled pipelines daily

[Timer]
OnCalendar=*-*-* 06:17:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl enable --now dogsled.timer
```

A timer does not start the service again while the previous run is still active,
so runs do not overlap. `journalctl -u dogsled` shows the logs.

With cron instead, set `PATH` to include the folder with `node` and `npx`, because
cron starts commands with a short `PATH`. Load the environment file inside the
command, and wrap it in `flock -n` so that a slow run and the next one cannot
overlap:

```text
PATH=/usr/local/bin:/usr/bin:/bin
17 6 * * * cd /srv/my-bobsled-project && flock -n /run/lock/dogsled.lock sh -c 'set -a; . /etc/dogsled/production.env; set +a; exec sh run-bobsled.sh'
```

### A container

For Airflow, Kubernetes or another platform that runs containers, build an image
with the project and its pinned packages:

```dockerfile
FROM node:24-bookworm-slim
WORKDIR /project
RUN chown node:node /project
USER node
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci
COPY --chown=node:node . .
RUN mkdir -p .extractor .bobsled/model-spec
ENTRYPOINT ["npx", "--no-install", "dogsled"]
```

Add a `.dockerignore` so that local data, state and credentials never enter the
image:

```text
.git
node_modules
.dogsled
.extractor
output
**/*.env
```

Pin the base image by digest (`node:24-bookworm-slim@sha256:...`) for repeatable
builds. Each container run is one command, with the credentials passed as
environment variables by the platform:

```bash
docker run --rm -e HELPDESK_TOKEN \
  -v dogsled-extract-state:/project/.extractor \
  -v dogsled-model-state:/project/.bobsled/model-spec \
  my-bobsled-project runner run helpdesk_tickets
docker run --rm \
  -v dogsled-extract-state:/project/.extractor \
  -v dogsled-model-state:/project/.bobsled/model-spec \
  my-bobsled-project model run --integration warehouse --json
```

A container starts with no state. Mount both state folders from storage that
outlives the container, as above, or copy the two files in and out around the run;
see [Keep state between runs](#keep-state-between-runs). The image runs as the
`node` user (uid 1000), so the storage must be writable by that user. A new Docker
named volume takes its owner from the folders that the image creates. In
Kubernetes, set `securityContext.fsGroup: 1000` on the pod, and run the image from
a CronJob with `concurrencyPolicy: Forbid`. In Airflow, run it from a task in a
DAG with `max_active_runs=1`. Both keep runs from overlapping.

## Checklist

- Pin Dogsled and the warehouse drivers in `package.json` and `package-lock.json`,
  and install them with `npm ci`.
- Declare every credential variable in `auth_env_vars`, and give secrets only to
  the steps that need them.
- Prefer short-lived credentials: Workload Identity Federation for BigQuery, and a
  key pair rather than a password for Snowflake.
- Keep `.extractor/state.json` between runs, and save it only after a successful
  run.
- Keep `.bobsled/model-spec/run-state.json` between runs, and save it after every
  `model run`.
- Keep `node_modules/`, `.extractor/` and `.bobsled/` out of Git. Never commit or
  cache `auth-state.json`.
- Run Dogsled with `npx --no-install dogsled`.
- Run `runner validate --strict` in pull requests, without secrets.
- Allow one run at a time, and set a time limit.
- Pin CI actions and base images to a commit or digest.
- Send failures somewhere a person will see them.
