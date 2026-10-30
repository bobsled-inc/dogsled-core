# Changelog

## Unreleased

- Replace the TV Night tutorial page with a chapter-focused offline explorer, saved-result tabs, file and lineage inspection, and guarded review requests for the agent.

Agentic models have simpler spend limits. Set `limits.max_cost_usd`, `limits.tokens`, or both. When a run reaches a cap, Dogsled stops starting new assignments, lets running ones finish, keeps every answer it already paid for, and says how much was spent. Raise the cap in YAML or with the new `--agent-max-cost` option and resume to continue. Before the first model call, a run whose input estimate alone exceeds the cap stops without spending. A dollar cap needs a known model price and otherwise fails before any call. Unknown usage now charges the attempt's input estimate rather than the whole remaining budget, and an attempt that used more than it reserved no longer makes a run impossible to resume. `tokens_per_assignment`, `tool_calls_per_assignment`, `model_calls_per_assignment`, `--agent-tokens-per-assignment`, and `tokensPerAssignment` are deprecated and ignored by new runs, and a run that sets them prints a warning naming each field. Runs saved earlier keep their original accounting when resumed. Library hosts supply prices through `AgenticHost.priceUsage`; `createAgenticHost` uses the built-in price table.

Agentic errors now say what went wrong and what to do next. State errors keep their code and add a reason and hint, for example `Agentic state limit (spend_cap_reached)`. A failed assignment names its step, assignment, attempts, and the executor's error kind and code. Host failures name the input or assignment, and storage causes show their system code. Causes that may contain secrets are shown only by type and HTTP status. Invalid executor output is retried instead of stopping the run, and its final error lists the invalid fields. New `--agent-retry-failed` resumes assignments saved as not retryable. Library callers can use `formatAgenticError`, `AgenticAssignmentError`, and `AgenticHostError`.

Stopping `dogsled model run` now stops the run. The CLI launchers forward SIGINT, SIGTERM, and SIGHUP to the process doing the work, so `kill`, a CI cancel, or a container stop no longer leaves a run making paid calls in the background. A cancelled run says what was kept and how to resume, a run still held by another process reports `run_in_progress` instead of a storage error, and `--json` output includes `cancelled`. Provider failures from `generateStructured` include the HTTP `status`. The reference executors report a rejected key (401 or 403) as an `auth` failure that is not retried or charged, and a 429 as a retryable `rate_limited` failure. AI Gateway models are priced at their underlying provider's list price, so dollar caps and budgets work through the gateway.

The reference loop executor retries provider errors and responses without usage, and stops after 16 turns when no call limit is set. `generateStructured`, `generateStream`, and `embedMany` now release their daily budget reservation when a provider call fails, so failed calls no longer use up the daily AI budget.

Clarify TV Night’s AI model setup, optional bounded recovery, and assessment quality review. Chapter 6 returns to explaining the model definitions after recovery, with a file-focused recap and inspection pause.

Warehouse agentic checkpoints batch payload chunks into bounded, parameterized INSERTs. Large snapshots need fewer warehouse requests while retaining the existing checkpoint format, durable attempt reservations, ownership fencing, and resume behavior.

Add the TV Night guided tutorial. Build an API connection, ETL pipeline, source and derived semantic models, cross-source queries, and agentic transformations with an agent. A local HTML page shows chapter progress, files, model lineage, and saved results. Agentic assessments select passage IDs so the executor attaches exact evidence, with a one-show check before the remaining batch and targeted retries.

BigQuery incremental extracts now succeed on all runs. The fix resolves three issues: named placeholders (`@p0`) in the generated SQL did not match the positional array the client sent; numeric cursor columns (INT64, FLOAT64, NUMERIC, BIGNUMERIC) are now cast correctly by reading the column type from BigQuery table metadata before each incremental run, so binding a STRING value against an INT64 column no longer fails; and value-based type inference is removed from the SQL-binding path so a STRING column whose value happens to look like a number is never miscast. Temporal cursors (DATE, DATETIME, TIMESTAMP) use a plain string parameter and rely on BigQuery's automatic coercion. Declare `cursor_type` explicitly in the resource spec to skip the metadata lookup.
## 0.1.0

All integration kinds, pipeline destinations, and webhook actions now require `auth_env_vars` for environment references, including legacy `*_env` fields. Bundled `<name>/source.yml` files also accept their `meta.yml` `auth_setup` declarations. AI model connections require declarations for custom API-key names. Undeclared names fail before lookup with a configuration hint.

Embedding hosts can declare supplied credentials through request API `declaredSecretNames`, pipeline SDK `declaredEnvNames`, or model/agentic `declaredSecretNames` with an explicit resolver. Project validation and compile APIs accept `declaredEnvNames`, and `resolveAgenticModel` accepts `declaredSecretNames`, for pipeline embeddings and `platform.models` profiles. Project validation warns about undeclared integration and action references. `dogsled runner validate` prints these warnings, and `--strict` fails on them. Default CLI behavior still requires YAML declarations.

**Breaking change for library callers:** `createJevExecutor` from `@bobsled-inc/dogsled/agentic` now requires an explicit `secretResolver` and throws without one. It no longer falls back to reading the profile's `api_key` name from `process.env`. Migrate with `createJevExecutor({ secretResolver })`, using the resolver you pass to `createAgenticHost`. The CLI `--agent-executor typesafe` path is unchanged.

Hosts that run models and sign in to providers themselves can set `hostManagedModelAuth: true` so `platform.models` profiles validate without declaring their `api_key` names. Embeddings and other credentials keep their declaration rules, and the CLI never sets it.

`parseReverseEtlProject` and `loadDogsledConfig` accept `declaredEnvNames` and `hostManagedModelAuth` and pass them to pipeline config loading.

Project Skills APIs (`loadProjectSkills`, `getProjectSkill`, `validateProjectSkills`, `buildProjectSkillsManifest`, `buildProjectSkillReferenceCatalog`) check Skill references against model and pipeline names without applying credential declaration rules, so undeclared `platform.models` or embedding keys no longer fail them. Structurally invalid pipeline config still fails, and Project validation, compile, and runs still enforce declarations. These APIs still accept `declaredEnvNames` and `hostManagedModelAuth`, but no longer need them.

Model `target_database` and `publish.target_database` accept hyphenated BigQuery project ids, quoted with backticks. Other dialects still reject hyphens, now with a dialect-specific message when the integration is known. `publish.target_database` is now validated as an identifier. Backtick-quoted identifiers reject backslashes and control characters, and BigQuery identifiers reject backticks.

Custom S3 endpoints require `static_env` credentials with every name declared, including session tokens. Standard AWS endpoints retain default credential-chain support. Postgres IAM authentication requires an AWS RDS endpoint.

Markdown parser `md:1.1.0` preserves blank lines before lists. Version `md:1.2.0` removes nested image badges inside links and their target URLs. Reparse existing documents to use the changed output.

Ossie `0.2.0.dev0` export now carries verified queries in a semantic-model `DOGSLED` extension, and import restores them as native `type: vq` files under `verified_queries/`. Export includes a query only when every dataset it refers to is selected. The `0.1.1` profile leaves verified queries out with a warning.

Extraction output mapped `from: { input: ... }` now records the inputs each request actually used, including declared defaults and each incremental window's generated bounds, for HTTP and MCP resources. Input values are never resolved from environment references, so a default that holds one is copied only as its literal text, and a request that templates it fails validation.

`oauth2` auth with `grant_type: client_credentials`, on an HTTP transport or a resource's `api.auth`, accepts an optional `resource`: an absolute HTTPS URL that Dogsled sends as the `resource` form parameter of the token request (RFC 8707 Resource Indicators). Some authorization servers mint an audience-bound token only when the request names the API it is for; without the parameter the token request succeeds but every API call with the token is rejected. Tokens are cached per `resource`, so one configured for one API is never sent to another. Configurations without `resource` send exactly the token request they sent before. Environment references in `resource` follow the same `auth_env_vars` declaration rules as `client_id` and `client_secret`. MCP HTTP transport auth and the catalog resource probe (`probeApiResource`) do not accept `resource` yet.

First release under the `@bobsled-inc/dogsled` package name. Earlier development history is private.
