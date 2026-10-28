# @bobsled-inc/connections

This workspace is bundled inside `@bobsled-inc/dogsled` and is not published on its own. User documentation is in [`docs/`](../../docs/README.md); this README describes the package for contributors.

Shared connection plumbing for the Dogsled monorepo. Owns integration + target YAML schemas, `${{ env.VAR }}` secret interpolation, connection construction, and the runner-resolution dispatcher.

Declare every resolved name in the integration’s `auth_env_vars`. Partial objects use `interpolateSecrets(value, resolver, { authEnvVars: integration.auth_env_vars })`.

Consumed by `@bobsled-inc/extractor`, `@bobsled-inc/loader`, and `@bobsled-inc/model-spec`.

## Status

Consumed by `@bobsled-inc/model-spec` today. Integration with `@bobsled-inc/extractor` and `@bobsled-inc/loader` is scoped to follow-up consolidation work.
