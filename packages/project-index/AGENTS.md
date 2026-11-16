# @bobsled-inc/project-index — Agent Guide

<!-- last-reviewed: 2026-09-22 -->

Type-based discovery for Bobsled Core project files. One scan reads every YAML/JSON file
and Markdown front matter under a project root and indexes each file by its
declared `type`, so authors can organize a project in any folder layout.
Every project loader receives its files from this index instead of walking a
fixed directory.

## Boundaries

- Depends only on `@bobsled-inc/protocol` and `yaml`. It must stay free of
  schemas, compilers, connection runtimes, and other workspace packages:
  hosts import it through `@bobsled-inc/bobsled-core/project-index` to classify
  content without loading the rest of Bobsled Core.
- The index decides a file's kind; it never validates a kind's schema. Each
  loader validates its entries and reports duplicate identities with both
  paths.
- `classifyProjectFile` and `indexProjectFiles` are pure. Only `scanProject`
  touches the filesystem.

## Invariants

- OSI candidates use content (`datasets`, `semantic_model`, or draft version
  cues), never an authored `type: ossie` marker. This classification does not
  validate or translate a document. Import into native files is the supported
  workflow; the model loader owns legacy direct-reader compatibility. Conflicting
  OSI and Bobsled Core markers are rejected. JSON files are considered only for OSI;
  unrelated JSON is left unrecognized.
- OSI content takes precedence, followed by an explicit Bobsled Core type, then the
  nearest exact conventional folder for an untyped document. Conventional
  object folders infer their kind at any depth. Historical root files
  `bobsled.yml`/`bobsled.yaml`, `model-spec.yml`, `extractor.yml`, `extract-intents.yml`,
  root `AGENTS.md`, and `skills/<name>/SKILL.md` retain their behavior. An
  untyped nonroot pipeline config content cue is rejected only when no kind
  applies. Folder names set only a kind, never an identity.
- `type: source` is a model source at `spec_version: '0.2'` and an
  integration at `spec_version: '2'`; without a version, only the fields one
  shape uses decide, and anything else is `ambiguous_source`.
- A conventional file that fails to parse keeps its kind so its own loader
  reports the error. The same failure elsewhere is an index issue.
- Hidden entries and `node_modules` are skipped in scans and in-memory
  indexes alike. Symbolic links are reported, never followed, except
  root-level Markdown links such as a `CLAUDE.md` alias for `AGENTS.md`,
  which are skipped. A linked root configuration file, a linked YAML file in
  a Bobsled Core folder, or any link under `skills/` blocks loaders, because Bobsled Core
  read or rejected those before.
- A file too large to classify, or not UTF-8, keeps the type its leading
  text visibly declares, so a typed Bobsled Core file still blocks its loaders.
- Readers that tolerate other problems (`discoverModels`, edit targets,
  `findConfigurationEntry`) still refuse a scan that stopped at a limit.
- Output is sorted by code-unit path order, so every host sees the same
  index for the same files.
- Adding a file type means adding it to `PROJECT_FILE_KINDS` and giving the
  owning loader an index-fed path; an unknown `type` is always an issue.

## Verification

```bash
pnpm --filter @bobsled-inc/project-index typecheck
pnpm --filter @bobsled-inc/project-index lint
pnpm --filter @bobsled-inc/project-index test:unit
```
