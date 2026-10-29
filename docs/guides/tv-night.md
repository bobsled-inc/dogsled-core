# TV Night guided quickstart

**What should I watch next?** Connect to TVmaze and build a small ETL pipeline with your coding agent. Then build the models, add Wikipedia context, and explain why a series fits your taste and time.

Install Dogsled using the [getting-started guide](../getting-started.md#install-dogsled). Ask Claude Code or Codex to run `npx dogsled onboarding guide`. No separate plugin or local server is needed.

```sh
npx dogsled examples init tv-night
cd tv-night
npx dogsled onboarding render
```

The page starts empty. There are no bundled records or finished models. Your agent helps you connect to TVmaze, fetch around 250 shows and their episodes (cast is optional), and load local tables. Public data reads need no API key. The agent helps configure your AI provider and key at the start; paid enrichment stays optional.

Follow the [walkthrough](../../packages/dogsled/examples/tv-night/README.md). Each lesson explains a Dogsled capability, shows the actual files and SQL, offers a small choice, and pauses for you to inspect the result. Your original question is saved in `data/tv-night/question.json` and shown in the HTML. The example answer develops alongside the lessons: a small catalog becomes a shortlist, then recommendations with supported explanations and checked identities. An ended show is not necessarily a concluded story.

The HTML shows your original question, chapter progress, answer history, working YAML and SQL files, model dependencies, and saved data previews. The six chapters end with evidence for every shortlisted show and a recommendation query. An optional exercise matches your watchlist to real TVmaze search candidates. Run `npx dogsled onboarding status` to check progress and `npx dogsled onboarding render` to refresh the page. Completed checks and learner inspections stay recorded when files or data change. The page shows timestamped check snapshots, not live database results. Run an explicit chapter check to refresh a snapshot or retry a failed check; rendering alone does not rerun work. API failures do not silently fall back to packaged data. After inspecting a result, tell your agent you are ready; it records the inspection with `dogsled onboarding review <step>`.

For optional SQL exploration, you can start [DuckDB UI](https://duckdb.org/docs/stable/core_extensions/ui.html) yourself with `duckdb -ui .dogsled/dogsled.duckdb` from your tutorial project folder after loading data. The tutorial does not launch or manage it. Close that database session before ETL or model writes to avoid locks. The HTML table previews and agent-run queries are enough to complete the guide.

The API-backed Wikipedia query joins remote article rows to local tables and shows cache receipts. The earlier TVmaze ETL is ingestion, not the federation demonstration. Read the example's source licenses before sharing fetched data or adapted text.
