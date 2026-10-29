# Changelog

## Unreleased

BigQuery incremental extracts now succeed on runs after the first. Three issues are fixed: the query used named placeholders (`@p0`) while the client passed a positional array; integer cursors stored as strings were not cast to INT64 (BigQuery does not coerce types automatically); and only an explicitly declared `cursor_type` is now used for SQL type binding, so a STRING cursor whose value happens to look like a number is no longer miscast. Temporal cursors (DATE, DATETIME, TIMESTAMP) use a plain string parameter and rely on BigQuery's automatic coercion, avoiding a DATETIME vs TIMESTAMP type mismatch.

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
