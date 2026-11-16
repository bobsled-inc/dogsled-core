# @bobsled-inc/project-index

This workspace is bundled inside `@bobsled-inc/bobsled-core` and is not published on its own. User documentation is in [`docs/`](../../docs/README.md); this README describes the package for contributors.

Type-based discovery for Dogsled project files. Dogsled scans a project once,
reads each YAML file's top-level `type` and each Markdown file's front matter
`type`, and hands every file to the loader for that type. Files can live in
any folder layout:

```text
datagolf/
  integration.yml        # type: integration
  players/
    raw_players.yml      # type: source
    players.yml          # type: model
    player_count.yml     # type: metric
  skills/
    player-lookup.md     # front matter type: skill
shared/
  bobsled.yml              # type: pipeline_config
```

An explicit type lets YAML definitions live in any folder; folder names do not
create semantic names or namespaces. Untyped YAML uses the nearest exact
conventional folder for its kind. Root `bobsled.yml` and `bobsled.yaml` remain
legacy pipeline configs and may omit `type`; nested pipeline fragments must
declare `type: pipeline_config`. A Project may have no pipeline config or
several fragments. Dogsled merges their `pipelines` and `destinations` by name;
each other top-level section has one owner. Root `model-spec.yml`, `extractor.yml`,
and `extract-intents.yml` retain their legacy conventions. `AGENTS.md` is a
guide in any directory, and `skills/<name>/SKILL.md` remains the conventional
Project Skill path. Other Markdown files declare `type: guide` or
`type: skill` in front matter.

## Types

| Type                                                                                                                                                         | Format   | Notes                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------- |
| `pipeline_config`                                                                                                                                            | YAML     | Zero or more fragments. Root `bobsled.yml` and `bobsled.yaml` may omit `type`; nested fragments declare it. |
| `model_spec_config`, `extractor_config`, `extract-intents`                                                                                                   | YAML     | One file of each per project.                                                                               |
| `integration`                                                                                                                                                | YAML     | Warehouse integrations use `spec_version: '1'`; API integrations use `spec_version: '2'`.                   |
| `source`                                                                                                                                                     | YAML     | A model source at `spec_version: '0.2'`; an API integration at `spec_version: '2'`.                         |
| `model`, `seed`, `metric`, `relationship`, `entity_relationship`, `vq`                                                                                       | YAML     | Model Spec objects.                                                                                         |
| `resource`, `action`, `sync`, `target`                                                                                                                       | YAML     | Extraction and activation objects.                                                                          |
| `resolution`, `relationship_ontology`, `mention_extraction`, `relationship_extraction`, `agent_task_profile`, `survivorship`, `truthset`, `object`, `policy` | YAML     | Entity Graph specs.                                                                                         |
| `agent`                                                                                                                                                      | YAML     | Recognized for host applications; Dogsled loads nothing from it.                                            |
| `skill`, `guide`                                                                                                                                             | Markdown | A Project Skill or guide, declared in front matter or inferred at a conventional path.                      |

The root `AGENTS.md` remains Project-wide. Nested `AGENTS.md` guides add
context for assets in their directory and descendants.

## Usage

```ts
import { assertValidProjectIndex, entriesOfKind, scanProject } from '@bobsled-inc/project-index';

const index = scanProject('/path/to/project');
assertValidProjectIndex(index);
for (const entry of entriesOfKind(index, 'model')) {
  console.log(entry.path, entry.document);
}
```

`indexProjectFiles(files)` builds the same index from `{ path, content }`
pairs held in memory, and `classifyProjectFile(file)` classifies one file.

## Limits and safety

A scan skips hidden entries and `node_modules`, reports symbolic links
instead of following them (root-level Markdown links, such as a `CLAUDE.md`
alias for `AGENTS.md`, are skipped), and stops at 32 directory levels, 250,000 entries,
10,000 YAML and Markdown files, 1 MiB per file, and 64 MiB in total. Malformed
YAML, unknown types, ambiguous `type: source` files, and duplicate project-wide
configurations are reported with their paths; `assertValidProjectIndex`
raises them as one validation error.

OSI documents are recognized by their content in YAML or JSON files. They have
index kind `ossie`, with no authored `type` marker. This classification does not
validate or translate the document. Import into native files is the supported
workflow. The model loader still owns legacy direct-reader compatibility. JSON
files without OSI cues remain unrecognized.
