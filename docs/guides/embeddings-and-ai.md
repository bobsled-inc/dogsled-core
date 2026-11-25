# Embeddings and AI providers

Dogsled calls AI models in three places: embedding text while loading, agentic models,
and entity-graph steps such as mention extraction. Agentic models and entity-graph steps
use _model roles_: named connections that you declare once in `dogsled.yml` and refer to
by name. Embedding names its provider and model in the embed configuration itself.

## Declare model roles

Roles live under `platform.models`. A role names a provider, a model and, for paid
providers, an environment variable that holds the key:

```yaml
platform:
  models:
    default_embedding_v1:
      provider: amazon-bedrock
      model: amazon.titan-embed-text-v2:0
      region: us-east-1
      dimension: 1024
    classifier_v1:
      provider: openai
      model: gpt-4.1-mini
      api_key: $OPENAI_API_KEY
  budget:
    ai_cost_daily_usd: 50
```

| `provider`                                    | Credentials                                                                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `amazon-bedrock`                              | The AWS default credential chain, or `api_key`. `region` defaults to `us-east-1`.                                 |
| `openai`, `anthropic`, `google`, `openrouter` | `api_key`, as an environment variable placeholder.                                                                |
| `ai-gateway`                                  | `api_key`. `model` is a `vendor/model` family ID such as `zai/glm-flash`; Dogsled maps it to the current version. |
| `ollama`                                      | None. `base_url` defaults to `http://127.0.0.1:11434/api`.                                                        |
| `typesafe`                                    | `api_key`. Only for agentic classification models.                                                                |

Every role also accepts `dimension` (vector size, for embedding roles) and
`cost_budget_usd` (a ceiling per call). `platform.budget.ai_cost_daily_usd` caps
the daily spend of AI calls in the project, and `per_source_rpm` limits request
rates for entity-graph mention extraction. Dogsled rejects literal keys: use
`$NAME` or `${{ env.NAME }}`. Standard provider key names are allowed. List custom key names in the model connection’s `auth_env_vars`.

## Check a role

`dogsled doctor` resolves every role and reports, for example, a role whose key
variable is not set:

```text
OK platform.models.default_embedding_v1: amazon-bedrock/amazon.titan-embed-text-v2:0 resolved
ERROR platform.models.classifier_v1: Environment variable "OPENAI_API_KEY" is not set
```

`dogsled ai test` sends a small embedding request and a small structured-generation
request through one role. It asks for the role's `dimension` where the model is known to
[take one](#vector-length):

```bash
dogsled ai test --connection default_embedding_v1
```

Set `DOGSLED_AI_TEST_STUB=1` to check the configuration without calling the
provider: the command then returns zero vectors and no cost.

```bash
DOGSLED_AI_TEST_STUB=1 dogsled ai test --connection default_embedding_v1 --json
```

```text
{"connection":"default_embedding_v1","provider":"amazon-bedrock","model":"amazon.titan-embed-text-v2:0","embedding":{"ok":true,"id":"sample","vector":[0,0,0],"tokenUsage":0,"costUsd":0},
```

## Embed records while loading

`dogsled embed` sits between `extract run` and `load run`. It adds a vector column
for each configured field of a stream and passes everything else through. Its
configuration is a JSON file.

Create `embedder.json`:

```json
{
  "provider": "openai",
  "model": "text-embedding-3-small",
  "api_key": "$OPENAI_API_KEY",
  "streams": { "users": [{ "field": "name" }] }
}
```

```bash
dogsled extract run --integration jsonplaceholder users --quiet \
  | dogsled embed run --config embedder.json \
  | dogsled load run --dest duckdb --db-path ai.duckdb
dogsled query "SELECT name, len(name_embedding) AS dims FROM users LIMIT 2" --db-path ai.duckdb
```

```text
[loader] users: loaded 10 rows
...
name	dims
Leanne Graham	1536
Ervin Howell	1536
```

The new column is named `<field>_embedding` unless you set `as`. The embedder
accepts the same providers as model roles, except `ai-gateway` and `typesafe`, and
also [`host`](#use-a-model-the-host-application-supplies).
`dogsled pipeline --embed-config-json '<json>'` runs the same step inside a
pipeline, and DuckDB, ClickHouse, pgvector, Chroma and Turbopuffer destinations
store the vectors.

## Embed in a project pipeline

A `dogsled.yml` pipeline takes the same configuration as an `embed` block. Its `streams`
keys are the names of the pipeline's resources:

```yaml
pipelines:
  handbook:
    schedule: manual
    source: files
    destination: local
    resources: [handbook]
    embed:
      provider: openai
      model: text-embedding-3-small
      api_key: $OPENAI_API_KEY
      streams:
        handbook: [{ field: text }]
```

For a [document resource](extract-from-files.md#parse-documents), such as `handbook`, the
key stands for its chunk stream, `handbook__chunks`. `text` is the only field it takes, and
the vector column is `text_embedding` unless you set `as`. The resource's other tables are
loaded as they are.

`dogsled embed run` and `--embed-config-json` do not read project files, so their keys are
exact stream names: `handbook__chunks`.

With one destination, a pipeline that embeds saves which files it has read only after
embedding and loading have succeeded. When either fails, or the run is cancelled, the next run
reads and embeds the same files again. The rows of a document are replaced; a resource that
appends rows from files can load some of them twice. One resource that always fails keeps the
others of the run from saving, so fix it or run it separately. A token of an HTTPS state
backend must stay valid until then. With several destinations, an incremental document
resource keeps no such record, so each run reads and embeds every file.

Versions before this one saved the record when extraction ended, so after a failure the next run
skipped those files and their rows were lost without a message. Runs without an embed stage, from
API and warehouse sources, or with several destinations save their state as before.

## Vector length

The vector column has the length in `dimension`. Without one, Dogsled knows the length of
`text-embedding-3-small` (1536) and `text-embedding-3-large` (3072) on OpenAI and of
`amazon.titan-embed-text-v2:0` (1024) on Amazon Bedrock. Every other model needs a
`dimension`.

A `dimension` you set is sent to the models that are known to take one, and the model then
returns vectors of that length:

| Provider         | Models                                             |
| ---------------- | -------------------------------------------------- |
| `openai`         | `text-embedding-3-*`                               |
| `google`         | `gemini-embedding-*`                               |
| `amazon-bedrock` | `amazon.titan-embed-text-v2`, `cohere.embed-v4`    |
| `ollama`         | All. The Ollama server decides what to do with it. |

An Ollama server before 0.11.11 ignores the request and returns vectors of the model's own
length.

For other models, set the length the model returns. A vector of another length, or with a
value that is not a finite number, fails the run, whatever the provider.

Each vector column has a `dimension`, and records the source column, provider and model in
`embedded_from`, so a query can be embedded the same way later.

## Use a model the host application supplies

With `provider: host`, the application that runs Dogsled supplies the embedding model, so
the project holds no provider, model or key:

```yaml
embed:
  provider: host
  dimension: 1024 # optional: fail when the host's model has another length
  streams:
    handbook: [{ field: text }]
```

The application sets an `https` endpoint and a token in the run's environment.
[Host-supplied embeddings](../reference/host-embeddings.md) describes the contract.
Whitespace-only text gets a null vector and is not sent, which is so for this provider only.
Chroma, ClickHouse and Turbopuffer refuse a row with a null vector.
