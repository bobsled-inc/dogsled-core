# @bobsled-inc/skills — Agent Guide

<!-- last-reviewed: 2026-09-02 -->

Bundled Dogsled Skill generation plus Project Skill document schemas and bounded loading.

## Source Of Truth

- `.agents/skills/<name>/SKILL.md` files with `exposed: true` are skill sources.
- A user's `skills/<name>/SKILL.md` files are Project Skill sources. Never merge them
  into the Built-in manifest or load them through agent adapter directories.
- A user's exact-case root `AGENTS.md` is the separate optional Project guide. It
  never belongs in the Built-in Skill manifest or a Project Skill directory.
- `content/catalogs/*.json` values and exposed skill names are append-only contracts.
- `src/generated-data.ts`, `plugins/dogsled/skills/`, plugin manifests, and marketplace
  catalogs are generated; never edit them directly. `generate:manifest` updates both
  the runtime manifest and the installable plugin from the same exposed skills.
- Transclusions are resolved during generation so bundled Skill bodies are
  self-contained.

After changing a skill, catalog, or transcluded document, regenerate and commit both
the source and generated output.

## Project Document Contracts

- A leading guide YAML block is Dogsled front matter only when it is a mapping with
  its own `description`. Keep unknown-only blocks as Markdown and tolerate extra
  keys beside `description`.
- Measure `ProjectGuide.byteLength` and the 32 KiB limit from raw source bytes.
  Accept only exact-case `AGENTS.md`, as a file or an in-root link to a file.
- Preserve exact strict v1 manifests for projects without a guide. Emit strict v2,
  with a required `guide`, only when one exists.

## Verify

```bash
pnpm --filter @bobsled-inc/skills generate:manifest
pnpm --filter @bobsled-inc/skills build
pnpm --filter @bobsled-inc/skills typecheck
pnpm --filter @bobsled-inc/skills lint
pnpm --filter @bobsled-inc/skills test:unit
```
