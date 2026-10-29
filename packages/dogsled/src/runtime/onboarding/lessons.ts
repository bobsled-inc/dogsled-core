import type { StepId } from './schema.js';

/** Teaching prompts are examples, never execution evidence or completion checks. */
export const lessons: Record<
  StepId,
  { learn: string; files: string[]; choice: string; inspect: string }
> = {
  connect: {
    learn:
      'Dogsled lets you connect to an API and expose its responses as data. An integration configures the connection; a resource defines the request and maps JSON fields into columns. Here, you will fetch one show from TVmaze.',
    files: ['integrations/tvmaze.yml', 'resources/tvmaze/probe.yml', 'sources/tvmaze_probe.yml'],
    choice: 'Pick the show for your first request. Compare its source ID with its name.',
    inspect:
      'Open the resource file and find the JSON path for name. Compare it with the returned row. Tell your agent when you are ready for ETL.',
  },
  load: {
    learn:
      'Dogsled lets you create ETL pipelines that fetch data from a source, turn it into rows, and load it into a database. Here, you will load TV shows and episodes from TVmaze into DuckDB. ETL stands for extract, transform and load.',
    files: ['dogsled.yml', 'resources/tvmaze/shows.yml', 'resources/tvmaze/episodes.yml'],
    choice:
      'Start with page [0] (around 250 shows), or choose more pages after reviewing the request count.',
    inspect:
      'Inspect one show and its episodes. Find the same show ID in both tables. Check the actual row counts before moving on.',
  },
  model: {
    learn:
      'Dogsled lets you build semantic models: reusable definitions of your data and its meaning. You configure fields, descriptions, relationships and named calculations called metrics. Here, you will describe the source records first, then build derived models for shows and episodes.',
    files: [
      'sources/shows.yml',
      'sources/episodes.yml',
      'models/shows.yml',
      'models/episodes.yml',
      'relationships/show_episodes.yml',
      'metrics/episode_count.yml',
    ],
    choice:
      'Choose one rule to model: how to handle missing runtime, or whether an average episode length is enough.',
    inspect:
      'Read a source field description and its corresponding derived field. Inspect their ai_context, one transformation expression, the show-to-episode join and the episode-count metric. Briefly compare the rows.',
  },
  query: {
    learn:
      'Dogsled lets you query your models and metrics. Ask your agent in plain English, inspect the SQL, or use your own SQL tool. Later, save useful rules as another model.',
    files: ['models/watch_next.yml', 'queries/shortlist.sql'],
    choice:
      'Choose an example question or ask your own. Your agent waits for your question before running it.',
    inspect:
      'Read the SQL and inspect an included and an excluded show. Explain which rule decided each result before continuing.',
  },
  federate: {
    learn:
      'Dogsled lets one query join local DuckDB models with a Wikipedia API source. Matching page IDs connect the two sides. Receipts show whether Dogsled fetched API records or reused its cache.',
    files: [
      'integrations/wikipedia.yml',
      'resources/wikipedia/articles.yml',
      'sources/wikipedia_articles.yml',
      'queries/context.sql',
    ],
    choice:
      'Inspect an identity match, then fetch article context for every finalist (at most five).',
    inspect:
      'Read the join SQL. Run it again and compare fetched versus cached receipts. Identify the local and remote parts before continuing.',
  },
  transform: {
    learn:
      'Dogsled supports agentic models: models that use an AI model and your instructions to turn input data into structured output. You define their inputs, instructions and output fields. Here, you will build one that reads article passages and produces assessments with references to saved passages. Code attaches the exact source text.',
    files: [
      'models/article_inputs.yml',
      'models/assessment_inputs.yml',
      'models/show_notes.yml',
      'models/recommendations.yml',
    ],
    choice:
      'Choose the same preference to assess for every finalist. Inspect one pilot before the remaining shows, within the approved API usage and any chosen dollar cap, or skip AI.',
    inspect:
      'Inspect the pilot’s judgment and selected passage IDs first. Then compare all finalists and any unknowns. Explain why your answer changed.',
  },
  resolve: {
    learn:
      'Dogsled supports entity resolution: finding records from different sources that refer to the same thing. You configure matching rules and review uncertain matches. Here, you will link watchlist entries to catalog shows.',
    files: ['entity-graph/watchlist_resolution.yml', 'models/watchlist_matches.yml'],
    choice:
      'Bring a watchlist with titles and any years or IDs you know. Review a real ambiguous candidate from TVmaze search.',
    inspect:
      'Inspect the resolution output and accept, reject or leave a pair unresolved. Use accepted matches to remove already-watched shows from your recommendations.',
  },
};
