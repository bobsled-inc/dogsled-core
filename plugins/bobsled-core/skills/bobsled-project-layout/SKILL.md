---
name: bobsled-project-layout
description: Decide how to group folders and name files in a Bobsled Core project —
  sources, resources, Model Spec models, metrics, relationships, VQs,
  integrations. Use when scaffolding a new Bobsled Core project, adding several
  entities at once, or whenever you're about to drop a new YAML into a top-level
  folder and need to decide where it lives and what to call it. Goal is
  intuitive grouping by source / pipeline / business domain so the project stays
  browseable as it grows. Avoid flat folders that mix unrelated entities.
---

# Bobsled Core Project Layout — Folder Grouping & File Naming

Use this skill whenever you're about to create one or more YAMLs in a Bobsled Core project and the answer to _"which folder does this go in, and what should I call it?"_ isn't already obvious from the project's existing layout. Default outcome: every entity lands in a folder that says _what it is and where it came from_, and every filename describes the thing — not its position in a list.

This skill is layout-only. It does not decide content; pair it with `bobsled-author-model-spec-model`, `bobsled-add-pipeline`, `add-integration`, etc. for the entity being created.

## How Bobsled Core finds files

Bobsled Core reads an explicit top-level YAML `type` at any valid path. A typed definition can live in any folder. If a YAML file has no `type`, Bobsled Core can infer its kind from the nearest exact conventional ancestor folder. An explicit `type` takes precedence over a folder convention, and inference never rewrites authored bytes. Folders never set an entity's semantic name, namespace, integration owner, warehouse, or schema.

- Untyped YAML files can inherit a kind from the nearest exact ancestor named `sources`, `models`, `integrations`, `resources`, `actions`, `targets`, `syncs`, `metrics`, `relationships`, `vqs`, `agents`, or `seeds`.
- Bobsled Core recognizes raw OSI documents before type or folder inference. Import them into native files for new work. A legacy direct reader remains for existing projects. A conflicting OSI and Bobsled Core marker is an error.
- The root `bobsled.yml` and `bobsled.yaml` remain valid untyped pipeline configurations. Pipeline configuration is never inferred from a `pipelines` or `settings` folder; every nonroot fragment declares `type: pipeline_config`.
- Existing root `model-spec.yml`, `extractor.yml`, and `extract-intents.yml` conventions remain valid. `AGENTS.md` is a guide at the root or under any directory; a Markdown file can also declare `type: guide` in its front matter. A conventional Skill is `skills/<name>/SKILL.md`; another Markdown file declares `type: skill`.
- Keep `name` explicit where its schema requires one. A Resource outside `resources/<integration>/` declares `integration: <name>`.

Two more consequences:

- A resource outside `resources/<integration>/` names its owner with `integration: <name>`.
- Models, integrations, syncs, and Skills have project-wide unique names; resources and actions are unique per integration (`<integration>/<name>`). A duplicate is an error that lists both paths.
- Bobsled Core merges all indexed pipeline configuration files by key. Put a nonroot fragment anywhere, declare `type: pipeline_config`, and keep each pipeline name, destination name, and single-owner top-level section in one file. Duplicate owners fail with both paths.
- Run Bobsled Core from the Project root. The aggregate loader resolves every fragment against that root. `--config` selects one file explicitly and keeps its single-file behavior.
- A file that declares a Bobsled Core type but cannot be read (malformed, over 1 MiB, or not UTF-8), and any problem inside a Bobsled Core folder (`models/`, `sources/`, `integrations/`, `resources/`, `skills/`, and the other conventional folders), stops every Bobsled Core command until you fix it.
- Bobsled Core never follows symbolic links. A linked root configuration file (`bobsled.yml`, `model-spec.yml`, `extractor.yml`), a linked YAML file in a Bobsled Core folder, or any link under `skills/` stops commands, so copy the file instead. Files Bobsled Core does not load, such as documentation, charts, templated YAML, and other links, are skipped and listed by `bobsled doctor`.

Bobsled Core discovers CSV files below any exact `seeds/` path segment. A bare CSV has a path identity and does not create a warehouse target. A YAML seed specification still requires `name` and a relative `payload.path`. Only a specification-backed CSV can participate in a requested warehouse load. Entity Graph specs retain their `entity_graph_dir` setting.

## Non-negotiable

**Never leave a top-level folder flat once it holds files from more than one source, pipeline, or business domain.** A `models/` or `sources/` directory full of unrelated YAMLs from different upstream systems is the single thing this skill exists to prevent — it's the layout that becomes unbrowsable first, and it gets worse with every new pipeline.

If you find a flat folder that has already crossed that line, surface it to the user and offer to reorganize before adding more.

## The grouping axes you can choose from

Pick the axis that matches how the user thinks about the project — and confirm with them when more than one fits. The same project may use different axes for different folders (e.g. `sources/` by integration, `models/` by domain).

| Axis                                  | When it fits                                                      | Folder shape                                                            |
| ------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **By integration / upstream system**  | ELT-heavy projects, multiple connectors landing in one warehouse  | `sources/linear/`, `sources/stripe/`, `resources/github/`               |
| **By Model Spec layer**               | Modeling-heavy projects with staging → marts                      | `models/staging/`, `models/intermediate/`, `models/marts/`              |
| **By business domain**                | Project spans clear domains (sales, finance, product)             | `models/sales/`, `models/finance/`, `metrics/product/`                  |
| **By target warehouse / dialect**     | One model materialized into multiple warehouses                   | `models/snowflake/`, `models/bigquery/`, `models/postgres/`             |
| **By pipeline**                       | Each named pipeline is logically isolated                         | `models/pipeline_revenue/`, `models/pipeline_growth/`                   |
| **By source or subject (data-first)** | Authors think in upstream systems or business subjects end to end | `datagolf/players/`, `crm/hubspot/` holding every kind for that subject |

For tiny projects (≤ ~5 files per folder), one level of grouping is enough; nest only when a sub-axis emerges (e.g. `sources/linear/issues_graphql.yml` is already grouped — don't add `sources/linear/graphql/` unless you actually have multiple variants).

Nested business domains are supported when each level adds useful context:

```text
golf/
  datagolf/
    pga/
      pipelines.yml  # type: pipeline_config
      events.yml     # type: model
```

The folders organize the Project; pipeline names and model names remain explicit semantic identifiers.

## Default starting layout

Drawn from `bobsled-overview` and the canonical example projects. Use this as the baseline when the user has no preference:

```text
my-bobsled-project/
  AGENTS.md                      # Project guide: data meaning, queryable data, vocabulary, conventions, caveats
  bobsled.yml
  extractor.yml
  model-spec.yml

  integrations/                  # one file per project-local integration
    <integration>.yml

  resources/<integration>/       # always group by integration
    <resource>.yml

  sources/<integration>/         # always group by integration (mirrors resources/)
    <resource>.yml

  models/                        # group by Model Spec layer OR domain — ask the user
    staging/<integration>/<model>.yml
    intermediate/<domain>/<model>.yml
    marts/<domain>/<model>.yml

  metrics/<domain>/<metric>.yml  # group by domain
  relationships/<domain>/<rel>.yml
  vqs/<domain>/<vq>.yml

  seeds/<domain>/<seed>.csv
  entity-graph/                  # entity-graph project files (if used)
```

A data-first layout groups every kind of file for one source or subject together instead:

```text
my-bobsled-project/
  AGENTS.md
  bobsled.yml
  datagolf/
    integration.yml              # type: integration
    players/
      raw_players.yml            # type: source
      players.yml                # type: model
      player_count.yml           # type: metric
    skills/
      player-lookup.md           # front matter: type: skill
```

Notes on the conventional default:

- Use `AGENTS.md` files to add data context at the root or a nested directory. Bobsled Core applies guides from the root down to an asset's directory, with the nearest guide providing the most specific context. Keep at most one guide in each directory. Put repeatable procedures in `skills/<name>/SKILL.md` and do not scatter guidance across README files.
- In the conventional layout, `resources/` and `sources/` are **grouped by integration**: a resource under `resources/<integration>/` needs no `integration:` field.
- `models/` defaults to **layer-then-domain** (the dbt convention) because it's the most widely recognized — but if the user is domain-first, flip them: `models/sales/staging/`, `models/sales/marts/`.
- Single-domain projects can skip the domain level entirely (`models/staging/`, `models/marts/`).

## File naming

Names describe _what the thing is about_, never its position in a pipeline or its kind. Aim for: read the filename → know what the entity represents without opening it. The folder already says which layer or domain it belongs to — don't repeat that in the filename.

- **Resources / sources:** mirror the API/table name exactly — `issues_graphql.yml`, `orders.yml`, `users.yml`. Don't invent shorter aliases.
- **Model Spec models:** name after the entity or business concept the model represents — `orders_enriched.yml`, `daily_revenue.yml`, `customer_lifetime_value.yml`, `active_cycles.yml`. **Avoid layer/kind prefixes like `stg_`, `int_`, `fct_`, `dim_`, `mart_`** — they restate what the folder already conveys and make filenames harder to read. If two models would collide across layers, that's usually a sign that the entity is being modeled at the wrong granularity in one of them; ask the user before reaching for a prefix to disambiguate.
- **Dialect-specific variants:** when the same model is materialized for multiple warehouses, prefix the filename with the dialect — `bigquery_daily_revenue.yml`, `snowflake_daily_revenue.yml` (or short forms like `bq_`, `sf_` if the project already uses them). Keep the un-prefixed file as the canonical/default when one exists.
- **Metrics:** `<measure>.yml` — `total_revenue.yml`, `order_count.yml`. Don't suffix with `_metric`.
- **Relationships:** `<left>__<right>.yml` — `orders__customers.yml`.
- **VQs:** short slug of the question — `monthly_revenue_by_region.yml`.
- **Integrations:** the canonical integration slug — `linear.yml`, `snowflake.yml`.

Avoid: layer/kind prefixes that restate the folder (`stg_`, `fct_`, `dim_`, `mart_`, `_metric`, `_model`), numeric prefixes (`01_orders.yml`), dated names (`orders_2025.yml`), generic names (`model_a.yml`, `new_metric.yml`), or names that only make sense in current context (`temp_fix.yml`).

When intuitive naming is genuinely ambiguous — multiple plausible names for the same concept, or a model that spans concepts — **ask the user** rather than guessing. Offer two or three concrete options framed against the project (see "When to consult the user" below).

## Decision flow when adding a new entity

1. **Identify the entity kind** — resource, source, model (and which layer), metric, relationship, VQ, integration, seed.
2. **Pick the top-level folder** — follow the layout the project already uses: the conventional kind folders or data-first subject folders. Do not mix both styles at the same level.
3. **Pick the subfolder axis** — if the folder already has subfolders, follow that convention; otherwise consult the user (see below).
4. **Name the file** per the rules above, and give it its `type:` line.
5. **Check the destination folder isn't about to become flat-with-mixed-origin** — if it is, propose grouping _before_ dropping the new file in.

## When to consult the user

Ask **one** question, with two or three concrete options framed against their project, rather than asking abstractly. If the user has no strong preferences, present a recommended default plus alternatives instead of an open-ended question.

Examples:

> "For `models/`, do you want me to group by **layer** (`staging/`, `marts/`) or by **domain** (`sales/`, `finance/`)? Layer is the default I'd recommend since you only have one domain so far."
> "We're about to add the third Stripe model — want me to start a `models/marts/finance/` subfolder so finance models stay together as more land?"

Don't ask when:

- The project uses the conventional layout for resources and sources (grouped by integration).
- The project already shows a consistent convention — follow it.
- It's the first or second file in a folder; flag the choice to make later but don't block.

## Reorganizing an existing project

If the user asks to "clean up" or you spot a flat-with-mixed-origin folder:

1. Group files into the chosen axis — keep changes layout-only, apart from the `type:` lines below.
2. Moving a file needs no configuration change, because Bobsled Core finds it by type. Add a type to any file that leaves its conventional location: a moved `bobsled.yml`, `model-spec.yml`, or `extractor.yml`, a Skill leaving `skills/<name>/SKILL.md`, and a resource leaving `resources/<integration>/` (it also needs `integration:`).
3. Verify with `bobsled-troubleshoot` before committing.
4. Land the reorganization as its own commit, separate from any content change.

## Anti-patterns to call out

- Flat top-level `models/` with files from three pipelines mixed together — the case this skill exists to prevent.
- Umbrella folders that add depth without meaning (`modeling/models/`, `data/sources/`) — group by something a reader recognizes.
- Subfolder named after the file inside it (`models/orders/orders.yml`) — collapse to `models/<group>/orders.yml`.
- An untyped YAML file outside the root legacy config names or a recognized kind folder — Bobsled Core cannot recognize it.
- Mixing axes within one folder (`models/sales/`, `models/staging/` side-by-side at the same level) — pick one axis per level.
