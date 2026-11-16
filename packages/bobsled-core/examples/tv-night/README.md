# TV Night: learn Dogsled by finding your next show

Build a small data project that answers your own question, such as “I liked The Expanse. What should I watch next with similar complexity and intrigue?” Your question stays visible while the answer gains evidence.

You and your agent create the files together. There are no bundled records or active finished models. Teaching templates stay inside the Dogsled installation and are not copied into your project. Your project contains the working files you build in `integrations/`, `resources/`, `sources/`, `models/`, `metrics/`, `relationships/`, `context/` and `queries/`.

## Welcome to the Dogsled tutorial

Welcome to Dogsled! In this tutorial, you’ll build a data project to help answer “What should I watch next?” You’ll bring in TV show data, organize it into models you can ask questions about, and add Wikipedia context to compare your options. Along the way, you’ll learn how to connect sources, build pipelines and use AI to turn text into useful data.

We’ll build it together, one chapter at a time. Your agent will explain the files and queries, help you run them, and pause so you can explore the results before moving on.

The data we load will be stored locally in a DuckDB database, by default `.bobsled/bobsled.duckdb` inside your project folder. You can query it directly with SQL or start DuckDB UI yourself if you want. Both are optional; the conversation and HTML previews are enough to follow the tutorial. The database and its data are created as we work through the steps.

- Chapter 1: connect to an API.
- Chapter 2: build an ETL pipeline.
- Chapter 3: build semantic models.
- Chapter 4: query your data.
- Chapter 5: query across sources.
- Chapter 6: build an agentic transformation.
- Optional: resolve records across sources using a watchlist.

Each chapter includes a small choice and a pause to understand the files, code and results. Ask questions at any point.

The opening stays in the agent’s final response, alongside the chapter list and a question about what you like to watch. The agent waits for your reply before setup. Chapter explanations and inspection links also stay in final responses, so they remain available after progress messages collapse.

The agent opens the generated HTML in the browser as soon as it is ready, then refreshes that same view after updates. If local HTML cannot be opened in the current environment, the agent explains the limitation and supplies the file link.

### For the guiding agent

`dogsled examples init tv-night` leaves teaching templates out of the project. Run `dogsled onboarding guide` to obtain `templatesPath`, the read-only template directory inside the Dogsled installation. Paths described below as setup references or inactive examples are relative to that directory, not the learner’s project. Read only the templates needed for the current chapter and author the working files with the learner. Do not copy the template folder. Reveal complete model solutions only when the learner asks for them.

## Before Chapter 1

The agent checks the installed Dogsled CLI and local database setup. In this repository, run the local `packages/bobsled-core/bin/cli.mjs` with Node; installed users run `dogsled`. Use a dedicated tutorial directory. Keep existing work on resume.

Save the recommendation question and viewing preferences separately in `data/tv-night/question.json`:

```json
{
  "original": "What should I watch next?",
  "preferences": "The learner’s exact answer about shows and themes they like"
}
```

A taste answer is not the question. For example, “Sci-fi, The Expanse, political intrigue, serious” belongs in `preferences`. Keep the default question unless the learner supplies their own actual recommendation question; preserve that question verbatim. Show the two fields separately in the page.

Configure any optional LLM provider and model now, using `platform.models.show_review` and an environment key reference. TVmaze, Wikidata and Wikipedia need no API key. The AI step can be skipped without blocking the other lessons. Never paste a key in chat or embed it in the page. Use the `ai-model-roles` skill for supported providers, including Vercel AI Gateway, environment names, pricing and budgets.

Choose the AI model for reliable structured assessments and briefly explain why it fits the task. A supplied provider key does not choose a model. Check the configured route, structured-output support, and supported output/reasoning settings using installed capabilities or provider documentation. Do not select a model solely because it is first in a list or inexpensive. Choose routine technical settings yourself and explain their purpose; do not ask a beginner to choose token counts. Keep allowances explicit and within the agreed scope.

Before any LLM API call, explain: “The AI chapter uses tokens from your own API account and may incur charges. It normally makes one call per finalist, up to five. Are you okay with that, would you like a dollar cap, or would you prefer to skip AI?” Record the choice and approved scope at setup. Default to `observe` only with consent: report available usage and cost without a dollar ceiling. Unknown pricing means cost is unknown, not zero.

Also ask whether to stop on failure or allow up to two additional recovery attempts for failed or rejected assessments. No recovery is the default unless chosen. Record the selected model, original call allowance, recovery allowance, permitted setting adjustments and any dollar cap separately. Failed calls count too. The pilot is part of the original five calls; an approved retry uses a recovery attempt. A no-cap choice does not authorize unlimited calls or retries. Keep automatic SDK retries disabled; recovery is a separate diagnosed attempt.

If the learner wants a cap, set `cost_budget_usd` on `platform.models.show_review`. The executor automatically selects `enforce` when this setting is present. The cap applies per call; explain the total allowance using the planned call count. Check pricing support now. If pricing is unavailable, explain the supported alternatives before proceeding; never silently drop a requested or existing cap.

Run `dogsled doctor --json` for configuration checks. This does not prove credentials work. If you choose a live `dogsled ai test --connection show_review --json`, agree on that small paid probe separately and include it in the approved call count and any chosen cost allowance. Do not discover an invalid key halfway through the tutorial.

The six chapters teach API connections, ETL pipelines, semantic models, querying, query federation and agentic transformations. An optional watchlist-matching exercise follows. At every chapter the agent explains the goal, shows a file and command, offers one useful choice, runs the work, gives a precise inspection task, recaps and pauses.

After each verified chapter:

```sh
dogsled onboarding verify connect
dogsled onboarding render
```

Replace `connect` with the chapter's step ID. Only after the learner confirms inspection, run `dogsled onboarding review connect` and render again. The page keeps execution checks separate from learner inspection. Saved history contains real query results, not invented before/after answers. File and database changes do not reset completed chapters or learner inspections. Results are timestamped snapshots from saved checks, not live data. Rendering refreshes the page without rerunning checks. Run an explicit chapter check to replace a snapshot; changed results need inspection again. Do not silently repeat paid work.

## Chapter 1 of 6: connect to an API

**Goal:** fetch one familiar show and understand a reusable API connection.

Dogsled lets you connect to an API and make its responses available as data you can load or query. You configure the connection, the request and how response fields become columns. Here, you’ll connect to TVmaze and inspect one familiar show.

An **integration** stores the shared connection settings. A **resource** describes an endpoint and maps its JSON response into columns. A **source** lets models and queries refer to that data. A resource can supply ETL ingestion or a query-time API request.

Show `integrations/tvmaze.yml`, `resources/tvmaze/probe.yml`, and `sources/tvmaze_probe.yml`. For example, `name: {type: string, path: $.name}` means “read the response's name field into a text column.” Explain this before running it.

Use the user's favourite show as the probe when they named one. Look up its real ID; do not infer the ID from a title. The inactive example uses The Good Place, ID 2790. Set the resource's show ID and the source filter consistently. Configure `integrations/warehouse.yml` and `.bobsled/config.yml` from the setup references so query-time results have a local cache.

```sh
dogsled extract run probe --integration tvmaze --limit 1
dogsled onboarding verify connect
dogsled onboarding render
```

**Inspect:** open the connection table, find the chosen show, compare its ID and name with the resource definition. The agent must point to the actual returned row. Explain that the cache is a reusable local copy, not a bundled dataset.

**Achieved:** a working API connection and a reusable resource. No recommendation yet. Next we load a catalog. Pause for inspection.

## Chapter 2 of 6: build an ETL pipeline

**Goal:** learn how to create and run an ETL pipeline in Dogsled.

Before any catalog load, show the pipeline files, expected tables and scope choice in a final response, then wait. Confirmation that Chapter 1 made sense is not approval of an unseen Chapter 2 plan. A partial shows load is not a finished ETL: say which tables and checks remain.

Dogsled lets you create ETL pipelines that fetch data from a source, turn it into rows, and load it into a database. In this chapter, you’ll build one to load TV shows and episodes from TVmaze into DuckDB. ETL stands for extract, transform and load.

ETL means fetch data, turn it into rows, and load it. Start with one TVmaze index page (up to 250 shows); choose the page internally and explain that this is an ID-ordered sample, not a popularity or similarity ranking. Fetch the catalog first and inspect genre coverage before choosing child requests. Offer “small sample” or “broader discovery” with request counts, rather than asking a beginner to choose page numbers.

Keep the full `genres` array. `primary_genre` is only a convenience field and must not drive genre membership checks. For a science-fiction question, preserve all genres and filter using the full list. If coverage is thin, propose a bounded expansion, such as four index pages, before fetching episodes. Explain fetched catalog count versus retained candidate count. No fixed minimum number of relevant shows is promised.

Show the pipeline's explicit page list and each resource's mapping. To reduce child requests after a genre decision, add an extractor filter to the parent resource, using a full-genre text field rather than the first genre:

```yaml
# Add to output, alongside the full genres array:
genres_text:
  type: string
  path: $.genres
# Under extract (Science-Fiction is an example, not a universal preference):
where:
  - field: genres_text
    contains: Science-Fiction
```

`for_each` passes each retained show's ID to the episode resource. A show and its episodes can then be joined on `shows.id = episodes.show_id`. Cast is optional: fetch it when it supports a cast preference or matching exercise. Do not spend requests on it merely to make the dataset look larger.

The default rate of two requests per second is our gentle tutorial setting, not Dogsled's capacity. One catalog page plus episode requests for 250 shows is about 251 requests; adding cast roughly doubles it. Report actual progress and row counts. Full refresh uses the complete desired page list and replaces the tutorial tables; it does not append pages.

```sh
dogsled runner validate
dogsled runner run tv
```

Show and run this first exploration query without waiting for the learner to ask whether querying is possible:

```sql
SELECT s.name, s.genres, e.season, e.number, e.runtime
FROM raw.shows s JOIN raw.episodes e ON s.id = e.show_id
ORDER BY s.name, e.season, e.number LIMIT 10;
```

Use `dogsled query` with `--db-path .bobsled/bobsled.duckdb`. Then verify `load` and render.

**Inspect:** select Raw shows, find a real multi-genre show, and inspect its full genre list. Then select Raw episodes and find the same show ID. State exact names and expected values from this run.

**Achieved:** a reusable ETL pipeline and queryable local records. Invite the learner to ask for recommendations based on these fields. Explain that semantic models and named metrics have not been built, so the agent cannot use them yet. Next, configure those definitions. Inspect the pipeline’s source/destination/resources and the episode resource’s for_each/show_id mapping alongside matching rows. Pause.

## Chapter 3 of 6: build semantic models

**Goal:** give the data reusable meaning that both humans and agents can inspect.

Dogsled lets you build semantic models: reusable definitions that explain what your data means and how to query it. You configure fields, descriptions, relationships between records and named calculations called metrics. Here, you’ll model shows and episodes so later questions use those shared definitions.

Show the existing source files and the planned derived model, relationship and metric before editing or creating them. A source describes existing data; a model defines a reusable transformation, materialized as a table or view. A relationship describes a join; a metric names a calculation. SQL is a way to express transformations or ask a one-off question.

First enrich the existing source models in `sources/shows.yml` and `sources/episodes.yml`, plus any other sources already created. Describe what one row represents and which records were fetched. Add descriptions to `schema.columns`: explain identifiers, the `episodes.show_id` join to `shows.id`, runtime units, missing values and source limits. Use supported `ai_context` fields for terms such as “series” and “TV programme” and guidance such as “ended does not prove story completion.” Ask the learner to clarify one term or rule and show the YAML change. These edits describe existing data; they do not reload or change rows. Add this information to later API sources too.

Next, introduce an ontology: shared definitions of the things in the data and
how they relate. Adapt `context/tv-night.ontology.yml.txt` and
`context/tv-night.mapping.yml.txt` from `templatesPath` into the learner's
`context/tv-night.ontology.yml` and `context/tv-night.mapping.yml`. Explain each
file before creating it; keep this within the model chapter.

The ontology says that an Episode is part of a Show. The mapping connects
`episodes.show_id` to the Show identity represented by `shows.id`, using the
existing warehouse sources. Never join the episode's own `id` to a show ID or
match shows by title alone.

```sh
dogsled ontology describe tv_night --concept Episode --yaml
dogsled ontology validate --strict --json
```

Inspect the `Episode → Show → ProductionStatus` path. If a query returns 20
episode rows, that does not mean 20 shows to recommend. Also, `ProductionStatus`
means what TVmaze reports about production. “Ended” does not mean the story has
a satisfying conclusion; later article evidence is needed for that assessment.

The ontology explains these distinctions. The semantic relationship below
defines the join, and the metric calculates the fetched episode count. Reading
or validating the ontology does not fetch shows, run a query, or assess a story.

Then build the derived models. Build `shows` and `episodes` with the learner. Preserve IDs, all genres, and unknown values. Add model and field descriptions, carrying relevant source meanings into the derived definitions; do not assume automatic inheritance. Model/column `ai_context` can hold plain-language guidance and alternative terms; it is guidance, not an automatically executed rule. Metrics support `synonyms` directly. Do not invent top-level model `synonyms` fields.

For example, explain “show”, “series” and “TV programme”; define premiere date, average runtime, and source coverage. State that an ended show may be cancelled and that an average does not bound every episode. Declare required keys so agentic inputs will validate later.

Offer one relevant decision: regular episodes or specials, strict runtime limit or an average, or treatment of missing values. Do not impose a runtime or ended-status preference that the user did not express. If specials are selected, change the upstream fetch too.

Create the show-to-episode relationship and a fetched-episode count metric with a description and synonyms. Show its result for a familiar show. Compare raw and modeled rows, and explain a real change or explicitly say when the added value is meaning rather than changed values.

```sh
dogsled model validate --integration warehouse
dogsled model run shows episodes --integration warehouse
dogsled onboarding verify model
dogsled onboarding render
```

**Inspect:** recap the source files updated and derived files created, with a short YAML excerpt explaining each change. Open a source field description and the corresponding derived field, then inspect the relationship and metric definition. Keep the data comparison brief. Explain where the agent reads semantic guidance; metadata alone does not change SQL results.

**Achieved:** reusable definitions and documented limits. Next we explore these models through questions, inspect the SQL, and learn when to create further models. Pause.

## Chapter 4 of 6: query your data

**Goal:** ask questions of your modeled data, understand the SQL behind an answer, and decide when to save reusable logic as another model. The TV shortlist is the worked example.

Open with: “Dogsled lets you query the models and metrics you’ve built. You can ask me questions in plain English; I’ll use those definitions to run a query and show you the SQL and results. You can also use your own SQL tool, such as DuckDB UI, if you prefer. In this chapter, you’ll explore your data and learn when to save a useful query as another model.”

Offer a few questions supported by the actual models and metrics, such as “Which shows match my preferred genres?”, “Which shows have the shortest average episode runtime?”, and “How many fetched episodes does each show have?” Say “Choose one of these, or ask your own question.” Put the introduction and invitation in the final response and wait before executing. If the learner already asked a specific query question, use it instead of asking again. Setup preferences alone do not authorize choosing their first question.

Run the learner’s chosen question, explain the SQL, and show it in a `sql` code block with the answer. Invite follow-up exploration in the agent conversation. The static HTML has no natural-language chat. Do not automatically equate political intrigue with a Thriller tag or add unchosen filters.

After exploration, introduce the next step with: “Next, we’ll build on your existing models to help you find a show worth watching. We’ll choose 3–5 shows to compare and save the selection rules in a new `watch_next` model.” Explain how it reuses the existing show model and agreed filters, and gives later queries and enrichment a shared selection. Keep the model-building purpose first, before discussing which shows to choose.

Explain that a one-off query answers the current question, while a reusable model saves agreed selection rules for future queries. Propose a shortlist relevant to the original question, explain each proposed filter and its trade-offs, and agree on the rules before building it. A Thriller tag can be suggested as a rough filter; it does not prove intrigue.

Introduce every named item by its type and purpose before using its bare name. `watch_next` is a model that defines the final comparison set; `models/watch_next.yml` is its definition file. If you create `candidates`, introduce it as a model that keeps the broader pool of qualifying shows, with its definition in `models/candidates.yml`. Explain their actual source relationship and filters. Do not assume the names explain their purpose.

For example: “I created two models: `candidates` keeps the broader set of shows that match our rules, and `watch_next` selects the five we’ll compare. I’ll now run them and check their results.” Adapt this to the actual count and files; do not imply the optional model exists if you did not create it. Saving a model definition is separate from running it to produce its table or view.

Save those rules in `models/watch_next.yml` and the inspection query in `queries/shortlist.sql`. Keep IDs, names, genre information and source URLs. Exclude the user's favourite and known watched shows when appropriate. Keep an optional broader `candidates` model for exploration; `watch_next` is the final, bounded comparison of at most five shows. Explain how finalists were chosen; alphabetical order is not a quality ranking.

If fewer than three qualify, explain it and offer a broader search. An empty result is valid. Do not invent extra candidates. Show one included and one excluded show and the rule responsible.

```sql
SELECT * FROM analytics.watch_next ORDER BY name;
```

Verify `query` and render. The page now records the actual shortlist in its history.

**Inspect:** open Your shortlist and its model file. Change one agreed rule, predict a result, then compare the actual query output. No AI judgment of similarity has happened yet.

**Achieved:** the ability to query models through questions and save reusable selection logic. Inspect SELECT/FROM/WHERE in queries/shortlist.sql and compare them with source/where in models/watch_next.yml. Explain why a row qualifies. Our current catalog lacks detailed story context; next we add another source. Pause for the learner’s own questions.

### Example recap: explain model construction

Use this structure after building models, adapting every detail to the actual files. This is a teaching example, not a required sampling policy. Do not create a grouping rule or a model merely to match this example.

> Dogsled lets you build new models from existing ones. We extended the `shows` model with two models: `shows` → `candidates` → `watch_next`.
>
> **The `candidates` model** is defined in `models/candidates.yml`. Its `source.ref` reads the existing `shows` model. Its `where` rule keeps science-fiction records and excludes the known favorite. A `CASE` expression creates a new `discovery_group` column from the genre tags. `materialization.type: view` makes this a reusable database view: it stores the query definition rather than a separate copy of the results.
>
> **The `watch_next` model** is defined in `models/watch_next.yml`. Its `source.ref` reads `candidates`, so it reuses the filtering and grouping we already defined. Its `where` rule removes the `Other` group. Its `qualify` rule keeps one row per remaining group, ordered by ID. `materialization.type: table` stores the selected rows when this model runs. This demonstrates both reusing a model and saving a bounded result. Lowest ID is only a repeatable sampling rule, not a quality ranking.

Show a short excerpt from the learner’s actual model definition and explain it. For the example above:

```yaml
source:
  ref: candidates
qualify: ROW_NUMBER() OVER (PARTITION BY discovery_group ORDER BY id) = 1
materialization:
  type: table
```

Explain that `PARTITION BY` groups rows, `ORDER BY id` gives each group a repeatable order, and `= 1` keeps its first row. Then name the actual command used to build the models and its verified outcome. Do not copy these settings if the learner’s model uses different rules.

Finish briefly: “The saved query in `queries/shortlist.sql` reads the built model; it does not define the selection logic. The result check passed. Inspect `source.ref` and `qualify` in `models/watch_next.yml`: can you see how it builds on `candidates`?” Mention row counts only if verified. Then explain which Dogsled capability the next chapter adds. Avoid a separate paragraph comparing individual shows.

## Chapter 5 of 6: query across sources

**Goal:** configure and query a second data source, joining its records with local modeled data.

Explain: “Dogsled lets you query across multiple data sources. This is called query federation. We’ll run one query combining our TV datasets in DuckDB with article data from Wikipedia.” Before running SQL, show the natural-language question: “Show my shortlisted series with their runtimes and Wikipedia introductions.” Afterward explain which fields came from which source, and offer another question such as “For shows under my runtime limit, show the available Wikipedia context.” Keep the generated SQL visible for inspection.

Make the central lesson explicit: **one SQL query joins two different data sources—our local DuckDB database and the Wikipedia API.** The API source is not just another table we loaded during ETL.

Show the chain: `watch_next` → accepted `show_links` → API-backed `wikipedia_articles`. TVmaze supplies catalog facts; Wikidata supplies identifiers and sitelinks; Wikipedia supplies text. Preserve each source's IDs and attribution. Resolve links before trusting article evidence.

Use shared IDs where available. For missing links, search candidates and compare title/aliases, year, country and available cast. Show evidence for accepted and rejected candidates; leave ambiguity unresolved. Do not call a shared-ID lookup a fuzzy-resolution run. A missing link is a visible gap, not a reason to silently assess fewer finalists.

Author `show_links` with `show_id`, `page_id`, `wikidata_id`, `source_url`, `attribution`, `match_method`, `evidence`, and `review_status`. Its accepted rows must cover every finalist before claiming complete federation. The learner reviews any uncertain link; routine clear IDs need no artificial ambiguity.

Use the Wikipedia summary resource for this federation lesson. It requests up to five introductions with `exintro`, a legal `exchars: 1200`, and preserved revision IDs. Set the source's `requested_titles` filter to the accepted titles joined with `|`. This exact field carries the request through the API-backed source.

```sql
SELECT s.name, a.title, a.revision_id, a.article_text
FROM analytics.watch_next s
JOIN analytics.show_links l ON s.id = l.show_id
JOIN sources.wikipedia_articles a ON l.page_id = a.page_id
WHERE l.review_status = 'accepted';
```

Walk through the query before executing it:

| Query reference                | Where the data lives                        | Role in this query                                  |
| ------------------------------ | ------------------------------------------- | --------------------------------------------------- |
| `analytics.watch_next s`       | Local DuckDB                                | Supplies the selected show’s ID and name.           |
| `analytics.show_links l`       | Local DuckDB                                | Maps `show_id` to the accepted Wikipedia `page_id`. |
| `sources.wikipedia_articles a` | Wikipedia API, fetched or cached by Dogsled | Supplies article title, revision and text.          |

Explain both joins: `s.id = l.show_id` connects the local show to its identity mapping; `l.page_id = a.page_id` joins that mapping to the API’s article record. The result’s `name` comes from the local model; `title`, `revision_id` and `article_text` come from the API source. There are three named relations here, but two data sources: DuckDB and Wikipedia. The accepted identity mapping makes their different IDs joinable.

Show how `integrations/wikipedia.yml`, `resources/wikipedia/articles.yml` and `sources/wikipedia_articles.yml` expose the API response as queryable rows. Dogsled requests the rows or uses a valid cache, then joins them locally. Wikipedia never receives this SQL. In the recap, restate which side is local and which is an API, and use actual receipts to distinguish a fresh fetch from cache reuse.

Save this in `queries/context.sql`. Run with `dogsled source-query`; show local versus remote columns, then run again and compare fresh-fetch versus cache receipts. The join executes locally. Do not describe a join of only saved files as a live API query.

Verify `federate` and render. **Inspect:** select Shows with article context, find each finalist, then expand one passage and inspect the source/revision and receipts. State the actual table row to inspect.

**Achieved:** a query across local DuckDB models and an API source. Inspect the Wikipedia connection, resource query_params, source mode/max_age, and JOIN keys in queries/context.sql. Compare fetch and cache receipts. The TV example now has source-backed context for all finalists. These introductions may be too short for interpretation. Next we gather relevant passages and assess all finalists equally. Pause.

## Chapter 6 of 6: build an agentic transformation

Dogsled supports agentic models: models that use AI and your instructions to turn input data into structured output. Here, each show gets a judgment against the learner’s preference, a short explanation, and references to supporting passages. Explain this purpose before fetching text or discussing provider calls. For a preference such as “sci-fi sagas with politics and intrigue,” explain which parts the evidence supports and which remain unknown.

**Required sequence:** prepare → pilot → inspect → finish approved runs → review quality → explain the build → pause. After a failed run is recovered, return to this sequence and finish the teaching recap. A request to run the remaining shows does not waive the recap.

Show the model chain and files: `article_inputs` stores prepared evidence for every finalist; `assessment_inputs` selects the IDs approved for this attempt; `show_notes` makes the AI assessment; `recommendations` joins it to catalog facts. A passage reference lets the learner inspect why the model made a claim. It is not a test of the AI’s ability to copy a quote. The AI selects passage IDs; the executor looks up the original text and adds evidence metadata itself.

### Prepare the evidence without AI calls

Inspect the introductions first. If they lack useful detail, fetch one full Wikipedia article per accepted finalist using the `full_article` resource. Do not use `exchars`, `exintro` or `exsentences` for full text. Save full articles and revisions locally. Select relevant sections for the agreed preference rather than blindly taking the first paragraph. Keep article scope visible, including an article that covers several versions of a show.

Build `article_inputs` with one row per finalist: required `show_id`, `revision_id`, bounded `article_text`, `passages`, `article_scope`, `source_url`, and attribution. Keep article_text at most 6,000 characters. `passages` is JSON text containing 1–12 objects with unique IDs `p1`, `p2`, etc. and exact contiguous text from that row’s article_text. Each passage is at most 1,200 characters; their combined text is at most 6,000. Preserve passage IDs and revision together; do not reuse old assessments after replacing their evidence.

Construct this JSON with code or SQL, copying text directly from the saved source. For example, after selecting and checking section offsets, use `json_object('id', 'p1', 'text', substring(article_text, start_offset, passage_length))` inside a JSON array. Do not ask an LLM to rewrite these passages. Show one ID and its text before execution. If the source lacks evidence, keep that gap visible; do not invent a passage.

### Define a small assessment

Use the same preference for every finalist. The AI returns `show_id`, `revision_id`, `fit`, `explanation`, and `passage_ids` (an array of up to six selected IDs). The executor adds `support_excerpt` and Dogsled evidence metadata from the saved input. Do not add unrelated theme/ending fields or duplicate quote fields. Use `supported` for direct evidence, `mixed` for partial support, `contradicted` only for explicit contrary evidence, and `unknown` for insufficient evidence. An unknown assessment is a valid result, with an empty passage list. A technically valid response still needs a review of its reasoning. Require an explanation that identifies the requested qualities supported by the passages, the qualities unsupported or unknown, and why the overall fit follows. A label such as “mixed” by itself is not an explanation. Do not confuse missing evidence with explicit contrary evidence. Keep the schema small; this is a review of meaning, not a word-count test.

Create `executor.mjs` from the package teaching template. Use the provider profile chosen at setup. The executor requests structured output with a configurable `maxOutputTokens` allowance, default 4,096. Change that local setting only after explaining its effect and checking the approved token/cost scope. It never silently shrinks output to fit an assignment. Its preflight input estimate is conservative, not measured usage. Neither a parse error nor unknown usage proves that output tokens ran out. Do not patch Dogsled or guess a provider-specific executor route.

### Run one show, inspect it, then run the rest

Count the pilot within the original approved batch: one call first, then at most four remaining calls. Keep any dollar cap and track the original and recovery allowances separately. Choose a pilot that usefully tests the agreed criteria, including gaps or partial support where available. One successful input does not prove all later inputs will succeed. A provider credential probe is a separate disclosed call. Before changing provider/model, verify supported structured output and the executor’s provider route from the installed capabilities; model availability alone does not prove executor compatibility. Do not claim a new key is required without checking the configured route.

Create `assessment_inputs` as a view over the complete `article_inputs`, with `where: show_id IN (...)` listing only the real pilot ID. Keep `show_notes` materialized with `replace_processed_keys` on `show_id`, so later attempts preserve successful rows. Never filter or overwrite the full article_inputs or shortlist tables to run a pilot.

Validate the files and confirm the scope query returns exactly one approved show. Run:

```sh
dogsled model validate --integration warehouse
dogsled model run article_inputs assessment_inputs --integration warehouse
dogsled query "SELECT show_id, revision_id FROM analytics.assessment_inputs" --db-path .bobsled/bobsled.duckdb
dogsled model run show_notes --integration warehouse --agent-executor ./executor.mjs --agent-run-id tv-pilot
dogsled model run recommendations --integration warehouse
```

Then run `dogsled onboarding verify transform --show-id <actual-pilot-id>`. This checks that show’s saved output without completing or resetting the chapter and without making an AI call. Explain the output fields and inspect whether the selected passages support the judgment. Pause for the learner’s inspection. If the pilot fails, stop the batch and diagnose that one show first.

Once inspected, process the remaining approved shows one at a time. Update only `assessment_inputs.where` to the next single show ID. Run `dogsled model run assessment_inputs --integration warehouse` to rebuild that view, then repeat the scope query and confirm it returns exactly that one show before running `show_notes` under a new run ID. Rebuild `recommendations` and check that show with `onboarding verify transform --show-id <id>`. Repeat for the other approved shows, stopping on a failure. Dogsled publishes a run only after all its assignments succeed: one show per run keeps each successful result saved even if a later show fails. These runs remain within the originally approved batch of calls; no extra call is needed. Editing YAML alone does not update an existing database view. Do not run the successful pilot again. After changing instructions or provider, test one affected show before expanding. Use additional attempts only within the explicitly approved recovery allowance; otherwise ask before spending. Diagnose the failure before a new attempt. Keep routine adjustments within the approved settings and dollar/token limits. Show the safe error and measured usage when available. Reaching an output allowance is relevant evidence, but a parse failure alone does not prove truncation. Do not silently change models, remove limits or increase the approved call count. Retry only failed or explicitly rejected show IDs; preserve successful notes and their original run IDs. Do not enable SDK automatic retries or use resume to bypass a no-retry policy. After any recovery, return to explaining what was built before presenting the final recommendation.

### Explain results and failures clearly

Distinguish these outcomes in both the recap and HTML:

- **Execution or response-format failure:** the provider call failed or its output could not be parsed. Show the safe error and available usage; do not judge assessment quality or guess truncation without evidence.
- **Invalid evidence link:** a passage ID is missing, belongs to another input, or the saved excerpt/revision does not match. Fix the preparation or output for that show. Exact text is attached by code, not rewritten by AI.
- **Judgment needs review:** the references are valid but do not support the interpretation. Explain the mismatch. Correct the instructions or gather better evidence before proposing a targeted retry.
- **Unknown from the evidence:** valid structured output that openly states a gap. This does not fail the chapter or prove a show is unsuitable.

Show which shows passed, failed or remain unknown. Do not describe a five-show result as wholly failed because one row needs repair. Full chapter verification still requires one valid current assessment and recommendation for every finalist; a pilot never completes it. Separately review the explanations for all requested criteria. Save a short review note per show with its review status and unresolved issues. Mark weak reasoning **needs review** in the recap, and do not use those unsupported claims to recommend a show. Preserve the model’s original output; do not replace it with your own better explanation or spend another call without approval. Technical verification can pass while quality review is still open.

Run the final comparison only when the remaining results are ready:

```sh
dogsled model run recommendations --integration warehouse
dogsled query "SELECT * FROM analytics.recommendations" --db-path .bobsled/bobsled.duckdb
dogsled onboarding verify transform
dogsled onboarding render
```

**Inspect:** explain the model definitions first, then compare one supported assessment and one unknown. Follow a selected passage ID to its saved text and discuss whether it supports the reason. The reference check proves traceability, not truth or recommendation quality. Keep spoilers collapsed. If inputs change without a new AI run, identify the old notes as saved results rather than silently rerunning them. Do not claim the best show in the catalog from a five-show comparison.

### Required final recap: explain what was built

Deliver this in the final response after the remaining runs, including after recovery. The earlier pilot explanation does not replace this recap. Spend most of the response on the model definitions; keep the show comparison secondary.

1. Explain the capability learned: Dogsled turns prepared input rows into structured assessments using a saved agentic model definition.
2. Walk through the actual chain `article_inputs → assessment_inputs → show_notes → recommendations`. Link each definition and explain its input, rule and output type. `article_inputs` stores prepared evidence; `assessment_inputs` is the view selecting one approved show; `show_notes` stores AI assessments; `recommendations` joins saved assessments to catalog data. Use the actual materialization settings rather than assuming every model is a table.
3. Show a short excerpt from the learner’s `show_notes.yml`. Explain `model_kind: agentic`, `llm.profile`, the preference instructions, required output columns and `materialization.strategy: replace_processed_keys`. Explain how processing one show preserves earlier rows. Do not substitute a SELECT query for this configuration explanation.
4. Explain the executor as a separate file: it calls the configured provider, validates the structured response, and attaches original text for selected passage IDs. The AI chooses references; code copies the exact text. Querying the saved `recommendations` view does not call AI. Executing `show_notes` can make new paid calls.
5. Give a brief result and quality summary, including valid unknowns and anything that still **needs review**. Link the saved results and review notes. Only then give a short, evidence-backed comparison without relying on weak judgments.
6. End with a file-linked task, such as: “Open `show_notes.yml` and find the preference instructions and output columns. Can you see which definition you would change to assess a different preference?” Pause for the learner’s inspection.

Before sending, check that the response contains the actual model chain, file explanations, an agentic YAML excerpt, query-versus-execution distinction, quality status and inspection question. If recovery occupied the conversation, restore this teaching context explicitly.

After all finalists pass the technical checks and the learner inspects the models and quality gaps, record the chapter review. Recap the six capabilities and the files that configure them. The optional next chapter teaches entity resolution: linking records across sources that refer to the same show. Introduce that concept before asking for a watchlist.

## Optional extension: learn entity resolution

**Goal:** match titles the user has watched to catalog records, then avoid recommending those shows again.

Dogsled supports entity resolution: finding records from different sources that refer to the same thing. You configure the matching rules and how uncertain matches are reviewed. Here, you’ll link watchlist entries to catalog records so already-watched shows can be excluded.

Ask for a short pasted list or CSV with `watch_id`, `title`, optional `year`, `country`, and any real external IDs. Preserve the user's original text. Do not invent viewing history. Without a user list, offer a clearly labelled title-matching exercise using live search results, such as the different series named Ghosts; verify actual candidates before teaching it.

Use TVmaze's show-search resource for each title and Wikidata for additional identity evidence where available. Search results are candidates, not accepted matches; the first result is not automatically correct. Load the watchlist and candidate records into separate local tables. Keep source identity, title/aliases, year, country, cast when useful, and shared IDs. Missing fields remain missing.

Now use the `entity-resolution` skill to author and run a real resolution spec and entity-graph pipeline against those loaded tables. The inactive `watchlist_resolution` reference demonstrates the shape. Normalize titles, block candidate comparisons, use exact shared IDs when present, and route fuzzy matches to review. Scores are matching signals, not calibrated probabilities. A UK show and its US remake must remain separate. Do not strip reliable IDs to force fuzzy matching.

Validate and compile first, then run the pipeline. Inspect its crosswalk and review queue. Let the learner accept/reject an uncertain pair, apply that decision using the review workflow, rerun, and show the resulting mapping. Preserve unresolved entries. Do not claim a hand-authored SQL mapping proves that the resolution engine ran.

Build `analytics.watchlist_matches` from the engine outputs and applied decisions: `watch_id`, `input_title`, nullable `candidate_id`, nullable `show_id`, `match_method`, `evidence`, `review_status` (accepted, rejected, unresolved). Keep a rejected candidate's reason but no accepted show ID. Validate `resolve`, then exclude only accepted watched IDs from the candidate model and rerun the shortlist. If new finalists appear, their evidence must be gathered before a new recommendation; no unapproved AI calls.

**Inspect:** compare the original watchlist entry, competing source records, review decision and accepted mapping. Show exactly which recommendation was removed, or honestly say none changed. Unresolved entries must not silently exclude shows.

## Tutorial scope

Keep tutorial work inside the learner's project. Do not suggest, recommend, offer to make, or perform changes to Dogsled's source code, installed packages, or a sibling development checkout to unblock the tutorial. A product limitation is not a tutorial coding exercise. Explain it briefly and offer supported configuration choices, an approved observe-mode run without a dollar cap, or skipping/pausing the affected lesson. Never remove an existing cap without the learner choosing that option. Keep prepared work so the tutorial can resume. Product fixes belong in a separate development task explicitly requested by the user, not an option proposed by this skill.

## Exploring the project

Lead each recap with what was built in Dogsled and how. Give most of the explanation to the actual files created or changed: link each path, identify its change, explain the important keys or expressions, and show how the files work together. Then show one short excerpt and the command that used these definitions. Source definitions and saved SQL deserve explanation alongside pipeline and model files.

For a model, explain the source and the columns, expressions, filters, relationships or materialization actually configured. For ETL, explain the pipeline, resource mappings and source definitions; semantic models come later. End with a short data check: row counts if useful, one result link and one inspection task tied to a file setting. Offer more exploration without making a long data checklist the main lesson. Finish with what the learner can now do, what the next chapter adds, and a pause.

The HTML follows [Dogsled’s visual style](DESIGN.md): compact tables, clear status labels, and light and dark themes. It shows the original question, chapter progress, actual answer history, working files, declared lineage, source attribution and bounded table previews. File previews are read-only snapshots, not live editing. The file tree shows working project files; teaching templates stay in the Dogsled installation. Secrets and data dumps are excluded. Model descriptions and SQL remain inspectable.

Use the HTML table previews and queries run with your agent to inspect the tutorial’s data.

**Optional:** if you prefer a separate SQL interface, you can start [DuckDB UI](https://duckdb.org/docs/stable/core_extensions/ui.html) yourself after loading data. From your tutorial project folder, with the official DuckDB CLI installed:

```sh
duckdb -ui .bobsled/bobsled.duckdb
```

The tutorial does not start or manage DuckDB UI. Close that database session before continuing ETL or model writes to avoid file locks. This is optional; every chapter can be completed without it.

The HTML itself runs no database queries. Its search/sort controls operate on saved previews (up to 500 rows per table). It reports total counts and generation time. Regenerate with `dogsled onboarding render` after changes. Rendering does not refresh query results. Run an explicit chapter check to update the saved snapshot; do not interpret saved previews as the current database.

Source limitations: TVmaze samples are incomplete; Wikipedia coverage differs; interpretations require review. Preserve the attribution in DATA-LICENSES.md. Data and model output are local; no tracking or remote artwork is added.
