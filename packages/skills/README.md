# @bobsled-inc/skills

This is a private workspace bundled inside `@bobsled-inc/dogsled`. Users
install only `@bobsled-inc/dogsled`; they do not install this package.

The workspace contains two separate Skill concepts:

- **Built-in Skills** are Dogsled authoring guidance shipped from this repository's `.agents/skills/` directory.
- **Project Skills** are guidance owned by one Dogsled project and authored under that project's `skills/` directory.

Their schemas, source directories, and manifests are separate.
The workspace also owns the parser for a project's optional root `AGENTS.md`.

## Built-in Skills

Versioned re-publish of the action-oriented authoring skills under
`.agents/skills/<name>/SKILL.md` plus the three discriminator catalogs
that the host agent uses when emitting Dogsled / Model Spec YAML.

The package mirrors the build-time-bake pattern used by
`@bobsled-inc/integrations/catalog`: a script
(`scripts/build-manifest.ts`) walks the source skills, resolves
transclusions, and writes a typed constant to `src/generated-data.ts`
which is bundled into the JS output. There is zero filesystem I/O at
runtime when using the package root or `/dogsled` subpath.

## Internal Dogsled catalog API

```ts
import {
  listSkills,
  getSkill,
  getCatalog,
  type SkillsManifest,
  type Skill,
} from '@bobsled-inc/skills';

const manifest = listSkills();
const skill = getSkill('dogsled-add-pipeline');
const integrationKinds = getCatalog('integration-kinds');
```

A clean-island subpath is also available:

```ts
import { listSkills } from '@bobsled-inc/skills/dogsled';
```

## Internal Project document API

The `/project` subpath parses and loads checked-in Project Skills and the optional
Project guide at runtime:

```ts
import {
  buildProjectSkillDocumentsManifest,
  loadProjectGuideDocument,
  loadProjectSkillDocuments,
  parseProjectGuide,
  parseProjectSkill,
} from '@bobsled-inc/skills/project';

const registry = loadProjectSkillDocuments('/srv/my-dogsled-project');
const guide = loadProjectGuideDocument('/srv/my-dogsled-project');
const manifest = buildProjectSkillDocumentsManifest(registry, guide);
```

Only a leading YAML mapping with its own `description` is Dogsled Project guide
front matter. Other blocks stay in the Markdown body, while extra keys beside
`description` are tolerated and ignored.

The filename is exact-case `AGENTS.md`. A link to a regular file inside the
project is allowed. `byteLength` and the 32 KiB cap use the raw source bytes,
before text normalization or body trimming.

A guide-free manifest keeps the exact strict v1 output and omits `guide`. A
manifest containing a guide uses strict v2, where `guide` is required. Both
versions reject unknown top-level fields.

This low-level subpath owns strict Skill schemas, bounded file loading,
deterministic hashes, and injected reference validation. Dogsled project
integration is exposed from `@bobsled-inc/dogsled/project-skills`.

## Which skills are exposed?

Any `.agents/skills/<name>/SKILL.md` with `exposed: true` in its YAML
front-matter is included in the manifest. Skills without that flag are
considered internal to Dogsled development.

## Dogsled agent host usage

Dogsled-maintained hosts can use this internal workspace as the bundled source of
Dogsled authoring and operating guidance. Load the manifest once, route by trigger
or name, then keep the selected Skill body in the agent context while editing
YAML or invoking Dogsled commands:

```ts
import { getSkill, listSkills } from '@bobsled-inc/skills/dogsled';

const available = listSkills();
const entityResolution = getSkill('entity-resolution');
const cleaning = getSkill('dogsled-model-spec-cleaning');
```

For entity graph work, the two most important exposed skills are:

- `entity-resolution` — resolution spec authoring, full vs incremental runs,
  review workflow, `get`/`match`/`serve` access-plane commands, PII scan, and
  right-to-erasure operations.
- `dogsled-model-spec-cleaning` — Model Spec cleaning expressions and entity-graph
  `standardize.transforms`, including address normalization, UID2-compatible
  email normalization, `hmac_sha256`, and `pre_hashed` match keys.

Runtime Dogsled MCP entity-graph tools are read-only (`entity_search`,
`entity_get`, `entity_match`, `entity_relationships`, `entity_explain`). When a
host agent needs to mutate graph state, route through the explicit CLI/HTTP
write surfaces documented in `entity-resolution`, such as `match --mode stage`,
`match --mode assign`, or `forget`; never infer a write from a read-only MCP
tool name.

## Transclusion

Skill source files can keep prose in `.agents/skills/<name>/SKILL.md`
and pull canonical reference content from elsewhere in the repo using
two marker forms:

- `{{include: <repo-relative path>}}` — full file body
- `{{include-section: <repo-relative path>#<heading>}}` — single
  markdown section (slug-matched, picks the heading line through the
  next same-or-shallower heading)

The build script resolves them, so the agent always receives a
self-contained skill body.

## Release model

- This workspace is private and is embedded in the single published
  `@bobsled-inc/dogsled` package.
- The manifest carries a combined SHA256 hash across every skill body
  and catalog. Any edit to a source skill, a transcluded doc, or a
  catalog value bumps the hash — consumers can cache on it.
- Catalog values and exposed Skill names are **append-only** for agent hosts.
  Removing a value or Skill is a breaking change and needs coordinated
  migration guidance.

## Development

```bash
pnpm --filter @bobsled-inc/skills generate:manifest  # regenerate src/generated-data.ts
pnpm --filter @bobsled-inc/skills build              # generate + bundle
pnpm --filter @bobsled-inc/skills typecheck
pnpm --filter @bobsled-inc/skills lint
pnpm --filter @bobsled-inc/skills test:unit
```

The drift-guard test (`tests/generated-data.test.ts`) fails CI if the
committed `src/generated-data.ts` doesn't match a fresh build.
