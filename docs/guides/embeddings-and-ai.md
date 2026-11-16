# Embeddings and AI providers

Bobsled Core calls AI models in four places: embedding text while loading, embedding
document chunks, agentic models, and entity-graph steps such as mention
extraction. All of them use _model roles_: named connections that you declare once
in `bobsled.yml` and refer to by name.

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
| `ai-gateway`                                  | `api_key`. `model` is a `vendor/model` family ID such as `zai/glm-flash`; Bobsled Core maps it to the current version. |
| `ollama`                                      | None. `base_url` defaults to `http://127.0.0.1:11434/api`.                                                        |
| `typesafe`                                    | `api_key`. Only for agentic classification models.                                                                |

Every role also accepts `dimension` (vector size, for embedding roles) and
`cost_budget_usd` (a ceiling per call). `platform.budget.ai_cost_daily_usd` caps
the daily spend of AI calls in the project, and `per_source_rpm` limits request
rates for entity-graph mention extraction. Bobsled Core rejects literal keys: use
`$NAME` or `${{ env.NAME }}`. Standard provider key names are allowed. List custom key names in the model connection’s `auth_env_vars`.

## Check a role

`bobsled doctor` resolves every role and reports, for example, a role whose key
variable is not set:

```text
OK platform.models.default_embedding_v1: amazon-bedrock/amazon.titan-embed-text-v2:0 resolved
ERROR platform.models.classifier_v1: Environment variable "OPENAI_API_KEY" is not set
```

`bobsled ai test` sends a small embedding request and a small structured-generation
request through one role:

```bash
bobsled ai test --connection default_embedding_v1
```

Set `BOBSLED_CORE_AI_TEST_STUB=1` to check the configuration without calling the
provider: the command then returns zero vectors and no cost.

```bash
BOBSLED_CORE_AI_TEST_STUB=1 bobsled ai test --connection default_embedding_v1 --json
```

```text
{"connection":"default_embedding_v1","provider":"amazon-bedrock","model":"amazon.titan-embed-text-v2:0","embedding":{"ok":true,"id":"sample","vector":[0,0,0],"tokenUsage":0,"costUsd":0},
```

## Embed records while loading

`bobsled embed` sits between `extract run` and `load run`. It adds a vector column
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
bobsled extract run --integration jsonplaceholder users --quiet \
  | bobsled embed run --config embedder.json \
  | bobsled load run --dest duckdb --db-path ai.duckdb
bobsled query "SELECT name, len(name_embedding) AS dims FROM users LIMIT 2" --db-path ai.duckdb
```

```text
[loader] users: loaded 10 rows
...
name	dims
Leanne Graham	1536
Ervin Howell	1536
```

The new column is named `<field>_embedding` unless you set `as`. The embedder
accepts the same providers as model roles, except `ai-gateway` and `typesafe`.
`bobsled pipeline --embed-config-json '<json>'` runs the same step inside a
pipeline, and DuckDB, ClickHouse, pgvector, Chroma and Turbopuffer destinations
store the vectors.

Document resources embed their chunks with `embedding: { role: <role> }`; see
[Extract from files](extract-from-files.md#parse-documents).
