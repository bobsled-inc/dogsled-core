# TV Night guided quickstart

**What should I watch next?** Connect to TVmaze and build a small ETL pipeline with your coding agent. Then build the models, add Wikipedia context, and explain why a series fits your taste and time.

Install Bobsled Core using the [getting-started guide](../getting-started.md#install-bobsled-core). In Claude Code or Codex, invoke the **`bobsled-tutorials`** skill, or ask:

> Use the bobsled-tutorials skill for TV Night.

The skill handles the welcome, setup, chapter order and pauses for inspection. No extra tutorial instructions are needed.

If your agent does not have the skill available, ask it to read `npx bobsled onboarding guide` and follow its instructions. This is a fallback for reading the bundled guide; installing the npm package alone does not register a skill with your agent. No separate plugin or local server is needed.

The agent handles these setup commands as part of the tutorial; you do not need to run them before invoking the skill:

```sh
npx bobsled examples init tv-night
cd tv-night
npx bobsled onboarding render
```

The page starts empty. There are no bundled records or finished models. Your agent helps you connect to TVmaze, fetch around 250 shows and their episodes (cast is optional), and load local tables. Public data reads need no API key. The agent helps configure your AI provider and key at the start; paid enrichment stays optional.

Follow the [walkthrough](../../packages/bobsled-core/examples/tv-night/README.md). Each lesson explains a Bobsled Core capability, shows the actual files and SQL, offers a small choice, and pauses for you to inspect the result. Your original question is saved in `data/tv-night/question.json` and shown in the HTML. The example answer develops alongside the lessons: a small catalog becomes a shortlist, then recommendations with supported explanations and checked identities. An ended show is not necessarily a concluded story.

The HTML shows your original question, chapter progress, answer history, working YAML and SQL files, model dependencies, and saved data previews. The six chapters end with evidence for every shortlisted show and a recommendation query. An optional exercise matches your watchlist to real TVmaze search candidates. Run `npx bobsled onboarding status` to check progress and `npx bobsled onboarding render` to refresh the page. Completed checks and learner inspections stay recorded when files or data change. The page shows timestamped check snapshots, not live database results. Run an explicit chapter check to refresh a snapshot or retry a failed check; rendering alone does not rerun work. API failures do not silently fall back to packaged data. After inspecting a result, tell your agent you are ready; it records the inspection with `bobsled onboarding review <step>`.

For optional SQL exploration, you can start [DuckDB UI](https://duckdb.org/docs/stable/core_extensions/ui.html) yourself with `duckdb -ui .bobsled/bobsled.duckdb` from your tutorial project folder after loading data. The tutorial does not launch or manage it. Close that database session before ETL or model writes to avoid locks. The HTML table previews and agent-run queries are enough to complete the guide.

The API-backed Wikipedia query joins remote article rows to local tables and shows cache receipts. The earlier TVmaze ETL is ingestion, not the federation demonstration. Read the example's source licenses before sharing fetched data or adapted text.

## Ontologies in Chapter 3

The model chapter also introduces an ontology for `Episode → Show → ProductionStatus`.
It explains why episode counts are not show counts, and why “Ended” does not prove
that a story reaches a conclusion. Its mapping uses the existing warehouse source
fields, including `episodes.show_id` and `shows.id`.

The agent adapts the [ontology template](../../packages/bobsled-core/examples/tv-night/reference/context/tv-night.ontology.yml.txt)
and [mapping template](../../packages/bobsled-core/examples/tv-night/reference/context/tv-night.mapping.yml.txt)
with the learner at that chapter. They stay inactive in the starter. Inspect them
with `bobsled ontology describe tv_night --concept Episode --yaml` and validate
with `bobsled ontology validate --strict`. No database or provider call is needed
for these definition checks.

## Shared tutorial engine

TV Night uses the shared `onboarding` engine for progress, saved checks, inspection
history and the offline chapter explorer. Its lessons, SQL checks, passage
validation and display content live under
`packages/bobsled-core/src/runtime/onboarding/tutorials/tv-night/`.

New projects identify themselves with `"tutorial": "tv-night"` in
`data/tv-night/manifest.json`. Existing manifests without that field, version 2
checkpoints and version 1 journals still work. Reading them does not reset or
rewrite progress. New progress includes the tutorial ID, and progress from another
tutorial is rejected.

Existing commands are unchanged, including `verify transform --show-id` and
`review --checkpoint`. `bobsled onboarding guide --tutorial tv-night` selects the
guide explicitly. Other commands find the tutorial from its manifest; an explicit
ID must match the project.

To add a built-in tutorial, implement `TutorialDefinition` and register it in
`runtime/onboarding/tutorials.ts`. Supply chapter order, teaching content, bounded
check queries, validation, answer history and display settings. Reuse the shared
renderer, browser controls, journal, safe file preview and CLI reader. Chapter
IDs use lowercase letters, digits and hyphens, start with a letter and have at
most 64 characters. Project manifests select registered definitions; they cannot
load executable tutorial code.
