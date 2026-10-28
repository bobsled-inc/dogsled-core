# Environment variables

Dogsled reads credentials only from environment variables that your files name,
for example `${{ env.STRIPE_API_KEY }}` or `$PG_PASSWORD`. Those names are yours to
choose. The variables on this page change Dogsled's own behavior.

## Output

| Variable                | Effect                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| `DOGSLED_OUTPUT_FORMAT` | `json` or `text`: the output format for commands that switch to JSON automatically. A `--json` flag still wins. |
| `CI`                    | When `1` or `true`, those commands print JSON.                                                                  |
| `NO_COLOR`              | Turns off colored output.                                                                                       |

## Network safety

| Variable                                | Effect                                                                                                                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS` | `1` lets extraction, actions and the state backend connect to loopback and private addresses, which are refused by default. Needed for databases, APIs and MCP servers on your own machine or network. |
| `DOGSLED_ALLOW_PRIVATE_OAUTH_HOSTS`     | `1` allows Snowflake OAuth token endpoints on private addresses.                                                                                                                                       |
| `DOGSLED_ENTITY_GRAPH_ALLOW_REMOTE`     | `1`, together with `entity-graph serve --allow-remote`, lets the entity API listen on a non-loopback address.                                                                                          |
| `DOGSLED_MCP_ALLOW_UNFILTERED`          | `1`, together with `mcp serve --allow-unfiltered`, allows MCP reads from declared sources without a permission adapter or principal. `dogsled doctor` warns when it is set.                            |

## State and credentials

| Variable                            | Effect                                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DOGSLED_STATE_BACKEND`             | Where extraction state is kept: `file://<path>` or an `https://` endpoint. `--state-backend` wins.                                                                 |
| `DOGSLED_STATE_AUTH_ENV`            | The name of the variable that holds the bearer token for an HTTPS state backend. `--state-auth-env` wins.                                                          |
| `DOGSLED_CREDENTIALS_TOKEN_COMMAND` | A command that prints a fresh warehouse access token as JSON (`access_token`, and `expires_at` or `expires_in`). `dogsled model run` uses it for model warehouses. |
| `DOGSLED_MATCH_KEY_SECRET`          | The key for `hmac_sha256` match-key transforms in models and entity resolution. Required when you use them.                                                        |

## Models and queries

| Variable                                                                                                     | Effect                                                                                                      |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `DOGSLED_XWH_STAGING_FORMAT`                                                                                 | `jsonl` (default) or `parquet`: the format used to copy data between warehouses for cross-warehouse models. |
| `DOGSLED_XWH_SOURCE_TIMEOUT_S`                                                                               | A timeout in seconds for each source copied by a cross-warehouse model. No timeout by default.              |
| `DOGSLED_MODEL_SPEC_DEBUG_SQL`                                                                               | Adds the generated SQL to model compile errors.                                                             |
| `DOGSLED_QUERY_INFLIGHT_DEDUP`, `DOGSLED_QUERY_INCREMENTAL_REFRESH`, `DOGSLED_QUERY_PARTIAL_MATERIALIZATION` | Experimental `source-query` optimizations, off by default.                                                  |

## AI and testing

| Variable               | Effect                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `DOGSLED_AI_TEST_STUB` | `1` makes `dogsled ai test` return zero vectors without calling the provider.                                    |
| `DOGSLED_EMBED_STUB`   | `1` makes embedding return synthetic vectors without calling the provider. Not for production data.              |
| `OPENAI_API_KEY`       | Read directly by the entity graph's semantic triage, which embeds candidate pairs with `text-embedding-3-small`. |
| `DOGSLED_CLI`          | The command `dogsled learn` uses to run lessons. `--cli` wins.                                                   |

CLI integration placeholders and `*_env` fields resolve only names declared in `auth_env_vars`. Bundled `<name>/source.yml` files also use declarations from their `meta.yml` `auth_setup`. Pipeline destinations and webhook actions declare their own names. API/MCP reserved names remain blocked, including in explicit maps.

Custom S3 endpoints, including MinIO and R2, require `static_env` credentials and declared names, including `session_token_env`. `default_chain` works only without a custom endpoint. Direct loader CLI flags still allow explicitly requested environment references.

Embedding hosts can pass `{ secrets, declaredSecretNames: Object.keys(secrets) }` to request APIs for `${{ secrets.NAME }}` templates. This option does not authorize `${{ env.NAME }}` or process environment fallback. Reserved API/MCP names stay blocked.

Pipeline SDK hosts can pass `declaredEnvNames` with `options.env` to `runProjectPipeline`. Each declared name must exist in that supplied map. These declarations cover source credentials and destination references without changing project YAML.

Model hosts can pass `declaredSecretNames` with an explicit `secretResolver` to `runProject` and `createAgenticHost`. The declarations authorize only listed names through that resolver, including checkpoint and cross-warehouse interpolation. The default CLI resolver still requires YAML declarations.

Validation and compile hosts can pass `declaredEnvNames` to `validateProjectPipelines`, `resolveProjectPipelines`, `loadProjectPipelineConfig`, `generateProjectManifest`, `loadDogsledConfig`, and `parseReverseEtlProject`. They can pass `declaredSecretNames` to `resolveAgenticModel`. Listed names count as declared for pipeline embeddings and `platform.models` profiles. Validation never reads their values. Without the option, undeclared custom key names remain errors. The resolved configuration carries these names in each profile's `auth_env_vars`, so use it only inside the host that declared them; do not persist it or pass it to a resolver backed by `process.env`.

Hosts that run every model profile with their own executor and sign in to the model provider themselves can pass `hostManagedModelAuth: true` to the same validation, compile, and reverse ETL functions, `runProjectPipeline`, `createAgenticHost`, and `resolveAgenticModel`. Each `platform.models` profile's own `api_key` name then counts as declared. Placeholders stay unchanged and no value is read. Pipeline embeddings, integrations, actions, and destinations keep their declaration rules. With `hostManagedModelAuth`, always pass an explicit `secretResolver`, and leave the option off if you use the built-in Jev executor. If Jev runs anyway, it resolves the key only through its explicit `secretResolver` and fails when the key is missing. The option defaults to `false`, and no CLI command sets it.

Project Skills APIs (`loadProjectSkills`, `getProjectSkill`, `validateProjectSkills`, `buildProjectSkillsManifest`, `buildProjectSkillReferenceCatalog`) read only model and pipeline names to check Skill references. They check the pipeline config's structure but not credential declarations, so they need neither option. They still accept both for compatibility.

AI model profiles accept these standard key names without a declaration: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `AI_GATEWAY_API_KEY`, `TYPESAFE_API_KEY`, and `AWS_BEARER_TOKEN_BEDROCK`. Each name applies only to its own provider. Any other name needs `auth_env_vars` or a host declaration.

Project validation warns when an integration or action references a name missing from its `auth_env_vars`. Requests reject these names at runtime, so validation reports them as warnings rather than errors.

Postgres IAM authentication requires an AWS RDS endpoint. Custom hosts require password authentication with declared environment names. [AWS documents the endpoint requirement](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.IAMDBAuth.html).
