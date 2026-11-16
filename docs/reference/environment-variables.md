# Environment variables

Bobsled Core reads credentials only from environment variables that your files name,
for example `${{ env.STRIPE_API_KEY }}` or `$PG_PASSWORD`. Those names are yours to
choose. The variables on this page change Bobsled Core's own behavior.

Core's own settings start with `BOBSLED_CORE_`. Core ignores the earlier `DOGSLED_*` names of these settings and prints a warning when one is set without its `BOBSLED_CORE_*` twin, so rename them, keeping their values. <!-- rename:keep -->

## Output

| Variable                     | Effect                                                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `BOBSLED_CORE_OUTPUT_FORMAT` | `json` or `text`: the output format for commands that switch to JSON automatically. A `--json` flag still wins. |
| `CI`                         | When `1` or `true`, those commands print JSON.                                                                  |
| `NO_COLOR`                   | Turns off colored output.                                                                                       |

## Network safety

| Variable                                     | Effect                                                                                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS` | `1` lets extraction, actions and the state backend connect to loopback and private addresses, which are refused by default. Needed for databases, APIs and MCP servers on your own machine or network. |
| `BOBSLED_CORE_ALLOW_PRIVATE_OAUTH_HOSTS`     | `1` allows Snowflake OAuth token endpoints on private addresses.                                                                                                                                       |
| `BOBSLED_CORE_ENTITY_GRAPH_ALLOW_REMOTE`     | `1`, together with `entity-graph serve --allow-remote`, lets the entity API listen on a non-loopback address.                                                                                          |
| `BOBSLED_CORE_MCP_ALLOW_UNFILTERED`          | `1`, together with `mcp serve --allow-unfiltered`, allows MCP reads from declared sources without a permission adapter or principal. `bobsled doctor` warns when it is set.                            |

## State and credentials

| Variable                                 | Effect                                                                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BOBSLED_CORE_STATE_BACKEND`             | Where extraction state is kept: `file://<path>` or an `https://` endpoint. `--state-backend` wins.                                                                 |
| `BOBSLED_CORE_STATE_AUTH_ENV`            | The name of the variable that holds the bearer token for an HTTPS state backend. `--state-auth-env` wins.                                                          |
| `BOBSLED_CORE_CREDENTIALS_TOKEN_COMMAND` | A command that prints a fresh warehouse access token as JSON (`access_token`, and `expires_at` or `expires_in`). `bobsled model run` uses it for model warehouses. |
| `BOBSLED_CORE_MATCH_KEY_SECRET`          | The key for `hmac_sha256` match-key transforms in models and entity resolution. Required when you use them.                                                        |

## Models and queries

| Variable                                                                                                                    | Effect                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `BOBSLED_CORE_XWH_STAGING_FORMAT`                                                                                           | `jsonl` (default) or `parquet`: the format used to copy data between warehouses for cross-warehouse models. |
| `BOBSLED_CORE_XWH_SOURCE_TIMEOUT_S`                                                                                         | A timeout in seconds for each source copied by a cross-warehouse model. No timeout by default.              |
| `BOBSLED_CORE_MODEL_SPEC_DEBUG_SQL`                                                                                         | Adds the generated SQL to model compile errors.                                                             |
| `BOBSLED_CORE_QUERY_INFLIGHT_DEDUP`, `BOBSLED_CORE_QUERY_INCREMENTAL_REFRESH`, `BOBSLED_CORE_QUERY_PARTIAL_MATERIALIZATION` | Experimental `source-query` optimizations, off by default.                                                  |

## AI and testing

| Variable                    | Effect                                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `BOBSLED_CORE_AI_TEST_STUB` | `1` makes `bobsled ai test` return zero vectors without calling the provider.                                    |
| `BOBSLED_CORE_EMBED_STUB`   | `1` makes embedding return synthetic vectors without calling the provider. Not for production data.              |
| `OPENAI_API_KEY`            | Read directly by the entity graph's semantic triage, which embeds candidate pairs with `text-embedding-3-small`. |
| `BOBSLED_CORE_CLI`          | The command `bobsled learn` uses to run lessons. `--cli` wins.                                                   |

CLI integration placeholders and `*_env` fields resolve only names declared in `auth_env_vars`. Bundled `<name>/source.yml` files also use declarations from their `meta.yml` `auth_setup`. Pipeline destinations and webhook actions declare their own names. API/MCP reserved names, such as `SLACK_BOT_TOKEN`, `GITHUB_TOKEN` and `AWS_SECRET_ACCESS_KEY`, stay blocked in explicit maps and cannot be enabled from Project YAML, including through `auth_env_vars`. Such a name resolves only when the host supplies it for the run with `declaredEnvNames` on `runProjectPipeline` or `declaredSecretNames` with an injected secrets map. In a CLI run with no host, it also resolves for a built-in source when the integration and every selected resource are the shipped files. A Project copy of a built-in source, or a Project resource on one, should use a different variable name.

Custom S3 endpoints, including MinIO and R2, require `static_env` credentials and declared names, including `session_token_env`. `default_chain` works only without a custom endpoint. Direct loader CLI flags still allow explicitly requested environment references.

Embedding hosts can pass `{ secrets, declaredSecretNames: Object.keys(secrets) }` to request APIs for `${{ secrets.NAME }}` templates. This option does not authorize `${{ env.NAME }}` or process environment fallback. A reserved API/MCP name resolves here only when it is both in the injected `secrets` map and listed in `declaredSecretNames`; a reserved name available only as an ambient credential stays blocked.

Pipeline SDK hosts can pass `declaredEnvNames` with `options.env` to `runProjectPipeline`. Each declared name must exist in that supplied map. These declarations cover source credentials and destination references without changing project YAML.

Model hosts can pass `declaredSecretNames` with an explicit `secretResolver` to `runProject` and `createAgenticHost`. The declarations authorize only listed names through that resolver, including checkpoint and cross-warehouse interpolation. The default CLI resolver still requires YAML declarations.

Validation and compile hosts can pass `declaredEnvNames` to `validateProjectPipelines`, `resolveProjectPipelines`, `loadProjectPipelineConfig`, `generateProjectManifest`, `loadBobsledConfig`, and `parseReverseEtlProject`. They can pass `declaredSecretNames` to `resolveAgenticModel`. Listed names count as declared for pipeline embeddings and `platform.models` profiles. Validation never reads their values. Without the option, undeclared custom key names remain errors. The resolved configuration carries these names in each profile's `auth_env_vars`, so use it only inside the host that declared them; do not persist it or pass it to a resolver backed by `process.env`.

Hosts that run every model profile with their own executor and sign in to the model provider themselves can pass `hostManagedModelAuth: true` to the same validation, compile, and reverse ETL functions, `runProjectPipeline`, `createAgenticHost`, and `resolveAgenticModel`. Each `platform.models` profile's own `api_key` name then counts as declared. Placeholders stay unchanged and no value is read. Pipeline embeddings, integrations, actions, and destinations keep their declaration rules. With `hostManagedModelAuth`, always pass an explicit `secretResolver`, and leave the option off if you use the built-in Jev executor. If Jev runs anyway, it resolves the key only through its explicit `secretResolver` and fails when the key is missing. The option defaults to `false`, and no CLI command sets it.

Project Skills APIs (`loadProjectSkills`, `getProjectSkill`, `validateProjectSkills`, `buildProjectSkillsManifest`, `buildProjectSkillReferenceCatalog`) read only model and pipeline names to check Skill references. They check the pipeline config's structure but not credential declarations, so they need neither option. They still accept both for compatibility.

AI model profiles accept these standard key names without a declaration: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `AI_GATEWAY_API_KEY`, `TYPESAFE_API_KEY`, and `AWS_BEARER_TOKEN_BEDROCK`. Each name applies only to its own provider. Any other name needs `auth_env_vars` or a host declaration.

Project validation warns when an integration or action references a name missing from its `auth_env_vars`. Requests reject these names at runtime, so validation reports them as warnings rather than errors.

Postgres IAM authentication requires an AWS RDS endpoint. Custom hosts require password authentication with declared environment names. [AWS documents the endpoint requirement](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.IAMDBAuth.html).
