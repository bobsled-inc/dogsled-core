# Project guide and skills

Coding agents such as Codex and Claude work better with a project when they know
what the data means and how to use it. A Dogsled project can carry that knowledge
in two kinds of Markdown files:

- The **Project guide**, a root `AGENTS.md` file: what the data means, which tables
  to query, vocabulary and conventions.
- **Project Skills**, files under `skills/<name>/SKILL.md`: instructions for one
  task, with references to the models, resources, actions and pipelines it uses.

Dogsled validates both, links skills into the folders where agents look for them,
and reports problems in `dogsled doctor`. It never runs a skill, and neither file
grants access to anything. The examples continue the `shop` project from
[Build models](build-models.md).

## Write a Project guide

Create `AGENTS.md`:

```markdown
---
description: What the shop data means and how to query it.
---

# Shop analytics

## About this data

Fictional orders from a small online shop, loaded from CSV files.

## Queryable data

- `analytics.customer_revenue`: order count and total amount per customer.
- `analytics.daily_revenue`: revenue per order day.

## Conventions

- Amounts are in euros. Timestamps are UTC.
```

The front matter is optional; a `description` there is used for discovery. The
suggested headings are About this data, Queryable data, Vocabulary, Conventions and
Caveats. Write facts that the project supports, and never include credentials or
private data. The file must be valid UTF-8 and at most 32 KiB.

## Write a skill

Create `skills/revenue-questions/SKILL.md`:

```markdown
---
name: revenue-questions
description: Answer questions about revenue per customer or per day.
triggers:
  - revenue by customer
  - daily revenue
references:
  - kind: model
    name: customer_revenue
  - kind: model
    name: daily_revenue
---

# Revenue questions

Use `customer_revenue` for totals per customer and `daily_revenue` for trends.
Both exclude refunds.
```

- `name` (required): lower-case kebab-case, up to 64 characters. Two skills cannot
  share a name.
- `description` (required): up to 500 characters.
- `triggers`: up to 20 short phrases that help an agent pick the skill.
- `references`: up to 100 links to a `model`, `resource`, `action` or `pipeline` in
  the same project. Dogsled checks that each one exists.
- Also allowed: `license`, `compatibility`, `metadata`, and `allowed-tools`
  (descriptive only; it grants nothing).

A skill folder can also contain scripts, references and other files; Dogsled
inventories them with their hashes but never executes them. A Markdown file
elsewhere in the project becomes a skill when its front matter has `type: skill`.

## Validate and inspect

```bash
dogsled skill validate
dogsled skill list
```

```text
✓ 1 Project Skill valid.
✓ Project guide AGENTS.md valid.
...
revenue-questions  Answer questions about revenue per customer or per day.
```

`dogsled skill show revenue-questions` prints one skill in full. Validation errors,
such as a reference to a model that does not exist, exit with code 2. Pass
`--no-guide` to validate skills in a repository whose root `AGENTS.md` is not a
Project guide.

## Make skills visible to agents

```bash
dogsled skill configure
```

```text
codex   revenue-questions  link  created  .agents/skills/revenue-questions
claude  revenue-questions  link  created  .claude/skills/revenue-questions
```

`configure` creates relative links from `.agents/skills/` (Codex) and
`.claude/skills/` (Claude) to each skill. Commit the links. It never replaces a file
or folder it did not create, and running it again changes nothing. Use
`--copy` where symbolic links are not available, and `dogsled skill sync` after you
change or remove a skill to refresh the copies. `dogsled doctor` reports invalid
skills and missing or stale links.

## Use them from code

The `@bobsled-inc/bobsled-core/project-skills` export loads, validates and hashes the
guide and skills for a host application: `loadProjectSkills`, `getProjectSkill`,
`loadProjectGuide`, `validateProjectSkills` and `buildProjectSkillsManifest`.
