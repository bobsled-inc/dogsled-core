---
name: ai-model-roles
description: Configure and validate Dogsled AI model roles, provider credentials, budgets, dogsled doctor, and dogsled ai test
---

# AI Model Roles

Use this skill when an agent needs to add, review, or debug `platform.models`, `platform.budget`, `dogsled doctor`, or `dogsled ai test`.

## Input

**Goal:** {{input}}

If the goal is missing, ask which model roles are needed:

- embedding
- structured generation
- streaming generation
- local smoke/stub validation only

## Step 1: Read The Contracts

Read the local docs and schemas before editing config:

- `docs/guides/embeddings-and-ai.md`
- `docs/reference/project-files.md`
- `packages/connections/src/schemas/model.ts`
- `packages/ai/AGENTS.md`
- `packages/dogsled/src/commands/doctor.ts`
- `packages/dogsled/src/commands/ai.ts`

Use provider role names in config and code. Do not hardcode provider model IDs into pipeline resources when a stable role can be referenced instead.

## Step 2: Choose Role Names

Use names that encode purpose and compatibility version:

```yaml
platform:
  models:
    default_embedding_v1:
      provider: openai
      model: text-embedding-3-small
      api_key: $OPENAI_API_KEY
      dimension: 1536
    mention_disambiguation_v1:
      provider: openrouter
      model: moonshotai/kimi-k2
      api_key: $OPENROUTER_API_KEY
```

Guidance:

- Use `*_embedding_v1` for vector-producing roles.
- Use task names such as `mention_disambiguation_v1` for structured generation roles.
- Keep provider credentials as `$ENV_VAR` placeholders only.
- List custom key names in the model connection’s `auth_env_vars`. Standard provider key names are allowed by default.
- Set `dimension` for every embedding role that may create vector columns.
- A pipeline's `embed:` block and a document resource do not use roles; the `embed:` block names its own provider and model.

## Step 3: Configure Budgets

Set per-call budgets on roles that can spend money:

```yaml
platform:
  models:
    extraction_v1:
      provider: openrouter
      model: moonshotai/kimi-k2
      api_key: $OPENROUTER_API_KEY
      cost_budget_usd: 0.25
```

Set a project daily budget when live AI calls can happen:

```yaml
platform:
  budget:
    ai_cost_daily_usd: 25
```

Notes:

- `@bobsled-inc/ai` reserves estimated budget before provider calls and finalizes with actual usage after the call.
- Direct package consumers must pass a stable `projectKey` when using a daily budget.
- Unknown paid model pricing fails closed. Add pricing coverage before relying on budget enforcement for a new paid model.
- `ollama` is treated as local/free for budget estimation.

## Step 4: Validate Config

Run project health checks:

```bash
dogsled doctor --json
```

Expected behavior:

- exit `0` when all checks are `ok` or `warn`
- exit `2` when any check is `error`
- `--json` and `--yaml` are available for agent-readable output

If live provider credentials are unavailable but the command path must be tested, use:

```bash
DOGSLED_AI_TEST_STUB=1 dogsled ai test --connection <role> --json
```

Stub mode validates config loading and role resolution only. It does not verify credentials, provider availability, pricing, or real token usage.

## Step 5: Probe Roles

Run a live probe for each role before treating it as production-ready:

```bash
dogsled ai test --connection default_embedding_v1 --json
dogsled ai test --connection mention_disambiguation_v1 --json
```

Interpretation:

- `embedding.ok: true` means an embedding probe succeeded.
- `structured_generation.ok: true` means a schema-validated generation probe succeeded.
- `skipped: true` means the selected provider/model factory does not expose that capability.
- `ok: false` with `budget_exceeded` means the cost guard blocked the call before or during reconciliation.
- `ok: false` with `provider_error` means credentials, provider resolution, pricing, or provider runtime failed.

## Step 6: Fix Common Failures

| Symptom                  | Fix                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| Raw API key rejected     | Replace with `$ENV_VAR` and configure the environment or runner secret.                      |
| Missing role             | Add the role under `platform.models` or correct `--connection`.                              |
| Missing `dimension`      | Add a positive integer dimension for embedding roles.                                        |
| Unknown model pricing    | Add the model to `packages/ai/src/pricing.ts` with tests, or choose an already-priced model. |
| Per-call budget exceeded | Raise `cost_budget_usd` or choose a cheaper model.                                           |
| Daily budget exceeded    | Raise `platform.budget.ai_cost_daily_usd`, wait for the next UTC day, or reduce call volume. |

## Step 7: Quality Gate

For docs/config-only changes:

```bash
pnpm docs:ci
pnpm format:check
```

For schema, command, or AI package changes:

```bash
pnpm --filter @bobsled-inc/ai typecheck
pnpm --filter @bobsled-inc/ai test:unit
pnpm --filter @bobsled-inc/dogsled typecheck
pnpm --filter @bobsled-inc/dogsled test:unit
pnpm precommit
```
