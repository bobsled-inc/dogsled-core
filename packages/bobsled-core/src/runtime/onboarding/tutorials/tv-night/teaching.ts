import type { StepId } from '../../schema.js';
export const teaching: Record<
  StepId,
  { code: [string, string][]; now: string; next: string; questions: string[]; beforeNext?: string }
> = {
  connect: {
    code: [
      [
        'integrations/tvmaze.yml',
        'Find base_url and auth: these configure the shared API connection.',
      ],
      [
        'resources/tvmaze/probe.yml',
        'Find endpoint and output.name.path: these choose the request and turn JSON into a column.',
      ],
      [
        'sources/tvmaze_probe.yml',
        'Find integration and resource: these expose the resource to queries.',
      ],
    ],
    now: 'You can fetch and inspect one show. We have not loaded a catalog or built semantic models.',
    next: 'Next, configure ETL to load many shows and their episodes into local tables.',
    questions: ['What fields did this API return for my show?'],
  },
  load: {
    code: [
      [
        'dogsled.yml',
        'Find the source, destination, resources and page list: these define what the pipeline fetches and where it loads rows.',
      ],
      [
        'resources/tvmaze/episodes.yml',
        'Find for_each and show_id: these fetch each show’s episodes and preserve the join key.',
      ],
    ],
    now: 'You can ask the agent to query the loaded records and suggest a show from the available fields. No semantic models or named metrics exist yet, so answers cannot use those definitions.',
    next: 'Next, build semantic models and metrics to give future questions shared meanings and reusable calculations.',
    questions: [
      'Which shows in our loaded data match my preferred genres?',
      'Show one series and its fetched episodes.',
    ],
  },
  model: {
    code: [
      [
        'context/tv-night.ontology.yml',
        'Follow Episode to Show and read ProductionStatus. Ended describes production, not story closure.',
      ],
      [
        'context/tv-night.mapping.yml',
        'Inspect episodes.show_id and shows.id. These identify the show each episode belongs to.',
      ],
      [
        'sources/shows.yml',
        'Inspect description, schema.columns and ai_context: these explain one source row, field meanings, units and alternative terms without changing the data.',
      ],
      [
        'sources/episodes.yml',
        'Inspect the episode ID, show_id join key and runtime description. Explain fetched coverage and unknown values.',
      ],
      [
        'models/shows.yml',
        'Inspect source.ref, column expressions, descriptions and ai_context: these define the model and explain its meaning.',
      ],
      [
        'relationships/show_episodes.yml',
        'Inspect join_columns: these describe how a show connects to its episodes.',
      ],
      [
        'metrics/episode_count.yml',
        'Inspect the expression and description: this counts fetched episodes, not assumed complete coverage.',
      ],
    ],
    now: 'Your data has reusable models, relationships and named calculations. You can query these definitions or build further models from them.',
    next: 'Next, explore the modeled data through questions and see the SQL behind the answers.',
    questions: [
      'What does our episode-count metric measure?',
      'Why does Ended not prove that the story reaches a conclusion?',
    ],
  },
  query: {
    code: [
      [
        'queries/shortlist.sql',
        'Read SELECT, FROM and WHERE: connect each part to the plain-English question and the returned rows.',
      ],
      [
        'models/watch_next.yml',
        'Compare its source and filters with the one-off query: this saves the selection logic as a reusable model.',
      ],
    ],
    now: 'You can ask your own questions, query the models, and model the data further. Choosing TV finalists is one example, not the limit of what you can explore.',
    next: 'Our catalog has structured facts but limited story context. Next, query across sources to add Wikipedia data.',
    questions: [
      'Which shows match my preferred genres?',
      'Which shows have the shortest average episode runtime?',
      'How many fetched episodes does each show have?',
      'What changes if I relax one of my preferences?',
    ],
  },
  federate: {
    beforeNext:
      'Once article text is available, the next chapter turns passages into structured evidence.',
    code: [
      ['integrations/wikipedia.yml', 'Inspect base_url: this adds a second API connection.'],
      [
        'resources/wikipedia/articles.yml',
        'Inspect query_params and output: these request and map Wikipedia records.',
      ],
      [
        'sources/wikipedia_articles.yml',
        'Inspect mode and max_age: these control query-time fetching and cache reuse.',
      ],
      [
        'queries/context.sql',
        'Trace s.id = l.show_id between local DuckDB models, then l.page_id = a.page_id to the Wikipedia API records. The show name is local; article title, revision and text come from the API source. Compare fetch/cache receipts.',
      ],
    ],
    now: 'Dogsled lets one query join two different data sources: your local DuckDB database and the Wikipedia API. The local watch_next model supplies shows, and the local show_links model maps their IDs to Wikipedia page IDs. The query joins those page IDs to the API-backed wikipedia_articles source for article text. Dogsled fetches or reuses cached API records and joins them locally; Wikipedia does not run the SQL.',
    next: 'Article text is now available, but it has not been assessed by an agentic model. Next, configure a transformation that turns passages into structured evidence.',
    questions: [
      'Show my shortlisted series with their runtimes and Wikipedia introductions.',
      'For shortlisted shows under my runtime limit, show the available Wikipedia context.',
    ],
  },
  transform: {
    code: [
      [
        'models/assessment_inputs.yml',
        'Inspect where: select one show per run, starting with the pilot. Each completed run saves its result before the next show starts.',
      ],
      [
        'models/article_inputs.yml',
        'Inspect the input keys, source revision and selected text: these define exactly what the model can read.',
      ],
      [
        'models/show_notes.yml',
        'Inspect model_kind, llm.profile, instructions, output columns and replace_processed_keys. Explain how one show becomes a saved assessment while earlier rows remain.',
      ],
      [
        'models/recommendations.yml',
        'Inspect the joins: these combine the finalists with structured assessments and evidence.',
      ],
      [
        'executor.mjs',
        'Inspect how the executor calls the configured AI model and attaches original text for passage IDs. It is separate from the model definition.',
      ],
      [
        'dogsled.yml',
        'Inspect platform.models.show_review: the agentic model names this provider profile through llm.profile.',
      ],
    ],
    now: 'You can define an agentic transformation and query its saved output. Reading recommendations does not call AI; executing show_notes can make new paid calls. Valid references still need a reasoning review. Unknown is a valid assessment, not an execution failure.',
    next: 'The core tutorial ends with this chapter. Dogsled also supports entity resolution: linking records from different sources that refer to the same thing, even when names differ. In the optional chapter, configure matching rules and review uncertain watchlist-to-catalog matches before excluding watched shows.',
    questions: [
      'How do the instructions and output columns in my agentic model produce an assessment?',
      'Which operation queries saved results, and which can make another AI call?',
      'Compare the reviewed assessments and identify any reasoning that still needs review.',
      'Which assessments remain unknown, and why?',
    ],
  },
  resolve: {
    code: [
      [
        'entity-graph/watchlist_resolution.yml',
        'Inspect inputs, blocking, scoring and review thresholds: these configure record matching.',
      ],
      [
        'models/watchlist_matches.yml',
        'Inspect accepted, rejected and unresolved mappings: only accepted watched IDs should exclude recommendations.',
      ],
    ],
    now: 'You can link records across sources while preserving uncertain matches for review.',
    next: 'Use these same capabilities with your own data sources and questions.',
    questions: ['Which watchlist entries need my review before we can match them?'],
  },
};
export const planned: Record<StepId, string> = {
  connect: 'Connect to TVmaze and inspect one show before loading a catalog.',
  load: 'Load shows and episodes into tables, then ask questions about the raw records. Semantic models come next.',
  model: 'Define reusable models, relationships and metrics before querying them.',
  query: 'Explore the modeled data through questions and inspect the SQL behind each answer.',
  federate:
    'Combine local DuckDB records with Wikipedia data in one query, then inspect the source and cache receipts.',
  transform:
    'Turn article passages into structured assessments. Inspect one pilot before assessing the remaining finalists. Unknown is a valid assessment, not an execution failure. A provider or format error needs an execution fix; invalid passage IDs need an evidence-link fix; weak reasoning needs review even when its IDs pass.',
  resolve: 'Match records across sources and keep uncertain matches for review.',
};
function agenticReviewPanel(): string {
  return `<div class="callout" data-agentic-review><h3>Explain the build before choosing a show</h3><p>Prepare → pilot → inspect → finish approved runs → review quality → explain the build → pause. Return to this sequence after any recovery.</p><p>Follow your actual model chain: <code>article_inputs → assessment_inputs → show_notes → recommendations</code>. Inspect each definition’s input, rule and output table or view.</p><p>Open <button type="button" data-file="models/show_notes.yml">models/show_notes.yml</button>. Find <code>model_kind: agentic</code>, <code>llm.profile</code>, the instructions, output columns and <code>replace_processed_keys</code>. Which definition would you change to assess a different preference?</p><p>Querying saved recommendations makes no new AI call. Running the agentic model can. The executor attaches source text; the model defines the assessment.</p><p><strong>Quality review:</strong> technical checks verify the saved references. An explanation must say which requested qualities are supported, which remain unknown, and why its overall fit follows. Mark weak reasoning <strong>needs review</strong> and keep it out of the recommendation. A valid unknown is not a failure.</p><p>Review the model definitions and any quality gaps before marking the chapter inspected. Recovery attempts require prior approval; a no-cap choice is not unlimited permission to retry.</p></div>`;
}
export const tutorialOverview = `<section class="stage" id="tutorial-overview"><h2>You’re starting the Dogsled tutorial</h2><p>Build a data project to help answer “What should I watch next?” Bring in TV show data, organize it into models you can ask questions about, and add Wikipedia context to compare your options. Your agent will explain the files and queries and pause after each chapter so you can explore the results.</p><p>The data you load will be stored locally in a DuckDB database, by default <code>.dogsled/dogsled.duckdb</code> inside your project. You can query it directly with SQL or start DuckDB UI yourself if you want. Both are optional; the conversation and this page’s previews are enough to follow the tutorial.</p><ul><li>1. Connect to an API</li><li>2. Build an ETL pipeline</li><li>3. Build semantic models</li><li>4. Query your data</li><li>5. Query across sources</li><li>6. Build an agentic transformation</li><li>Optional: learn entity resolution using your watchlist</li></ul></section>`;

export const teachingHtml = { transform: agenticReviewPanel() };
