# @bobsled-inc/dogsled — Agent Guide

<!-- last-reviewed: 2026-09-02 -->

The unified CLI package. `dogsled` is the only CLI command. It merges ELT tooling with local project commands.

---

## Two Command Strategies

| Strategy                  | Commands                                                   | Why                                                                                                       |
| ------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Direct import**         | init, act, sync, vq, source-query, skill                   | No native deps. Saves 150-600ms subprocess overhead                                                       |
| **Subprocess delegation** | extract, embed, load, model, entity-graph, query, pipeline | DuckDB native bindings need process isolation. `pipeline` can wire extractor -> embedder -> loader safely |
| **Direct local checks**   | doctor, ai test                                            | Pure config/model-role validation with structured output and no native dependency boundary                |

**Rule**: If a new command needs native deps, use subprocess delegation. Otherwise, use direct import.

## Adding a New Command

Follow this pattern for direct-import commands:

```typescript
async function commandHandler(localOptions: {...}, globalOptions: GlobalOptions): Promise<void> {
  const outputOpts = fmt.toOutputOptions(globalOptions);
  const projectRoot = resolveActionProjectRoot(globalOptions.config);
  // Command logic here
  // Use fmt.info/error/success/debug — never console.*
  // Use process.exitCode = N; return; — never process.exit()
}

export function registerXxxCommand(program: Command): void {
  program.command('xxx').option(...).action(async (opts) => {
    await commandHandler(opts, program.opts<GlobalOptions>());
  });
}
```

Register the command in `src/index.ts`.

## Config Resolution Priority

Highest to lowest:

1. CLI flags (`--project-root` selects the Project root; `--config` selects one config file explicitly)
2. Environment variables
3. Pipeline configuration indexed from the Project root, including legacy root `dogsled.yml` and `dogsled.yaml` files plus typed `pipeline_config` fragments
4. Built-in defaults

Pipeline configuration is optional. Local Project commands use the current working directory as the Project root unless you pass `--project-root`. With both `--project-root` and `--config`, resolve the config path relative to the Project root and keep `--config` limited to that one file.

In default Project mode, Dogsled merges typed pipeline fragments by pipeline and destination name. Duplicate names or repeated single-owner sections are errors. Untyped YAML objects can live in nested conventional folders; an explicit `type` allows a file anywhere. The nearest exact conventional folder infers only the file kind. It does not supply a name or namespace. A root `dogsled.yml` is a supported legacy form, not a required Project marker.

## Output Modes

All commands support `--json`, `--verbose`, `--quiet`. JSON mode auto-activates in CI, non-TTY, or `DOGSLED_OUTPUT_FORMAT=json`. When adding JSON output for an agent-consumable command result or export, also add equivalent `--yaml` output. Do not apply this to JSONL protocol streams, structured logs/events, or fixed external API contracts unless a YAML consumer is explicitly needed.

**Always use `fmt.*` functions** from `lib/output/formatter.ts` — never `console.log` or `console.error`.

## Exit Codes

| Code | Meaning          |
| ---- | ---------------- |
| `0`  | Success          |
| `1`  | Runtime error    |
| `2`  | Validation error |
| `3`  | Drift detected   |

Always use `process.exitCode = N; return;` — never `process.exit()`.

## Delegation Behavior

- `extract`, `embed`, `load`, `model`, `entity-graph`, and `query` delegate by subprocess to their respective package CLIs
- Root parsing short-circuits for delegated subcommands (e.g., `dogsled extract run --help` shows underlying command help)
- `embed` accepts bare flags without an explicit `run` subcommand (for example `dogsled embed --config ./embedder.json`)
- `pipeline` is the only composed command — it wires extractor stdout to loader stdin, or extractor -> embedder -> loader when `--embed-config-json` is present
- `pipeline` forwards output controls (`--json`, `--verbose`, `--quiet`, `--log-format`) across extract, embed, and load so stderr stays machine-parseable
- Inline `--embed-config-json` payloads are validated, written to a `0600` temp file, and then passed to the embed subprocess by path
- Delegation resolved via `runtime/delegation.ts` (argv matching) and `runtime/workspace.ts` (find CLI entrypoints)

## Pipeline Setup Guidance

- For net-new repos, prefer `setup recommend -> render -> doctor` before trying to run `pipeline`
- `setup render` must use exclusive creation for authored `AGENTS.md` and `skills/project-overview/SKILL.md`; preserve and report existing paths instead of overwriting them
- For existing extractor projects, validate the pieces independently:
  - `dogsled extract validate <integration>`
  - `dogsled load check --dest <destination> ...`
  - `dogsled pipeline --integration <integration> --resource <resource> ...`
- For reusable embedding workflows, prefer checked-in config files and explicit `extract | embed | load` composition
- For one-off automation, `dogsled pipeline --embed-config-json` is the shortest path

## Vector And Embed Notes

- Protocol `vector` columns require a `dimension`; the embedder derives it from the selected model
- Smoke tests can set `DOGSLED_EMBED_STUB=1` to avoid live OpenAI calls while preserving vector dimensions
- Destination choice matters for embedding workflows; consult `packages/loader/README.md` and `packages/loader/AGENTS.md` before enabling vectors downstream
- Shared model roles live under `platform.models` in `dogsled.yml`; use `dogsled doctor --json` to validate config and `dogsled ai test --connection <role> --json` for provider probes
- `dogsled ai test` should pass a stable project key into `@bobsled-inc/ai` so `platform.budget.ai_cost_daily_usd` can be enforced without mixing projects
- Use `DOGSLED_AI_TEST_STUB=1` only for command wiring tests; it does not verify provider credentials, pricing, or model availability

## Build & Distribution

- Onboarding HTML stays self-contained. Edit the inputs under
  `src/runtime/onboarding/assets/`, then run `node scripts/onboarding-assets.mjs`;
  never hand-edit `assets.generated.ts`. The package build checks asset drift.
- Keep visual-review scenarios and their selectors in the separate
  `scripts/onboarding-preview*.ts` generator, outside the production artifact.
- **tsup** bundles into `dist/index.js` (ESM, ~400KB)
- `__CLI_VERSION__` injected at build time via tsup `define`
- `scripts/pack.sh` creates distributable zip with standalone binary + `install.sh`
- npm publishes only `@bobsled-inc/dogsled`; the supporting workspaces in
  the release package set (`INTERNAL_PACKAGE_NAMES`) stay private and are
  embedded from a `pnpm deploy` staging tree through `bundleDependencies`
- external library compatibility lives in explicit Dogsled subpath wrappers;
  keep internal source imports on workspace entrypoints
- Library agentic hosts use the `/agentic` factory with a supplied project, executor,
  secret resolver, and SQL runner options. Keep CLI file loading in its CLI adapter.
  Input preparation and scoped source reads must use the same supplied runners.
  Hosts can supply `integrationSpecLoader` for project API resources. Apply the
  same source permissions, billing checks, and response bounds to supplied specs.
- Project Skills use the public `/project-skills` subpath and the direct-import `skill`
  command group. Skill content comes from `skills/`; `.agents/skills` and
  `.claude/skills` are discovery adapters only. The exact-case root `AGENTS.md` is
  a separate Project guide.
- `loadProjectSkills`, `getProjectSkill`, `validateProjectSkills`, and
  `buildProjectSkillsManifest` validate the guide and honor `options.guide` by
  default; preserve `guide: false` as the Skills-only opt-out.
- CLI `skill list` and `skill show` deliberately ignore the guide. Both forms of
  `skill validate`, including `validate <name>`, validate and report it.
- Preserve `--no-guide` on `skill validate` and `doctor` as the explicit
  compatibility escape hatch for repositories whose root guide is not Dogsled-owned.

## Key Source Directories

| Directory             | Purpose                                                            |
| --------------------- | ------------------------------------------------------------------ |
| `src/commands/`       | Command handlers (one file per command)                            |
| `src/lib/output/`     | Formatter: human, JSON, tables, colors                             |
| `src/lib/transports/` | BYO-endpoint transports for `act` / `sync` (api, webhook)          |
| `src/groups/`         | Help + command shells for delegated subcommands                    |
| `src/runtime/`        | Delegation, process spawn, workspace resolution                    |
| `src/setup/`          | Setup catalog, recommendations, rendering, doctor                  |
| `src/runner/`         | Pipeline configuration, manifests, validation, and local execution |

## Development

Host model discovery must agree with the model-spec DAG: agentic dependencies
come from `sources` aliases, and an exact self-reference reads old output rather
than creating an edge. Keep externally supplied manifest metadata compatible.

```bash
pnpm --filter @bobsled-inc/dogsled dev -- --help
pnpm --filter @bobsled-inc/dogsled build
pnpm --filter @bobsled-inc/dogsled typecheck
pnpm --filter @bobsled-inc/dogsled lint
pnpm --filter @bobsled-inc/dogsled test:unit
```

## Testing

- Vitest with `vi.mock()` for outbound HTTP and filesystem
- Tests in `tests/unit/` mirror `src/` structure
- Group tests verify command registration and help output
- Pipeline tests mock `spawn` and validate extract-only plus extract -> embed -> load process wiring
- Command, transport, sync, and runner tests cover full CLI behavior

Jev classification uses the built-in `typesafe` executor or exported `createJevExecutor`. Keep provider credentials outside serialized assignments, and resolve keys only through the caller's required `secretResolver`; never add an environment fallback. The model-spec classification contract owns choice and row validation; the executor owns HTTP and usage mapping.

## Guided tutorials

Keep tutorial-specific lessons, checks and display settings under
`src/runtime/onboarding/tutorials/<id>/`. Reuse the shared engine and offline
explorer. Only built-in definitions may supply code; project manifests select IDs.
Preserve legacy TV Night progress, guarded review fingerprints and pilot checks
that leave chapter progress unchanged.
