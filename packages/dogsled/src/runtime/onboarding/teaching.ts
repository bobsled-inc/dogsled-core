import type { StepId } from './schema.js';
import { escapeHtml as e } from './html.js';
export const teaching: Record<
  StepId,
  { code: [string, string][]; now: string; next: string; questions: string[] }
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
    questions: ['What does our episode-count metric measure?'],
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
        'models/article_inputs.yml',
        'Inspect the input keys, source revision and selected text: these define exactly what the model can read.',
      ],
      [
        'models/show_notes.yml',
        'Inspect sources, instructions, output columns and limits: these configure the agentic transformation.',
      ],
      [
        'models/recommendations.yml',
        'Inspect the joins: these combine the finalists with structured assessments and evidence.',
      ],
    ],
    now: 'You can query structured assessments backed by source passages, compare unknowns, and explain a recommendation. An exact quote still needs interpretation and review.',
    next: 'The core tutorial ends with this chapter. Dogsled also supports entity resolution: linking records from different sources that refer to the same thing, even when names differ. In the optional chapter, configure matching rules and review uncertain watchlist-to-catalog matches before excluding watched shows.',
    questions: [
      'Compare all finalists against my preference and show the supporting evidence.',
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
const planned: Record<StepId, string> = {
  connect: 'Connect to TVmaze and inspect one show before loading a catalog.',
  load: 'Load shows and episodes into tables, then ask questions about the raw records. Semantic models come next.',
  model: 'Define reusable models, relationships and metrics before querying them.',
  query: 'Explore the modeled data through questions and inspect the SQL behind each answer.',
  federate:
    'Combine local DuckDB records with Wikipedia data in one query, then inspect the source and cache receipts.',
  transform:
    'Turn article passages into structured assessments for all finalists, then compare their evidence.',
  resolve: 'Match records across sources and keep uncertain matches for review.',
};
export function teachingPanel(step: StepId, complete = false): string {
  const lesson = teaching[step];
  return `<div class="code-inspection"><h3>Code to inspect and understand</h3><ul>${lesson.code.map(([file, why]) => `<li><button type="button" data-file="${e(file)}">${e(file)}</button><p>${e(why)}</p></li>`).join('')}</ul></div><h3>${complete ? 'At the end of this chapter' : 'What you will build'}</h3><p>${e(complete ? lesson.now : planned[step])}</p><h3>Questions to try</h3><p>Ask in your agent conversation. Start with the question in plain English; inspect the SQL underneath its answer. Adapt these examples to the fields you have built.</p><ul>${lesson.questions.map((q) => `<li><button type="button" data-copy="${e(q)}">${e(q)}</button></li>`).join('')}</ul><p><strong>Why the next step follows:</strong> ${e(!complete && step === 'federate' ? 'Once article text is available, the next chapter turns passages into structured evidence.' : lesson.next)}</p>`;
}
export const tutorialOverview = `<section class="stage" id="tutorial-overview"><h2>You’re starting the Dogsled tutorial</h2><p>Build a data project to help answer “What should I watch next?” Bring in TV show data, organize it into models you can ask questions about, and add Wikipedia context to compare your options. Your agent will explain the files and queries and pause after each chapter so you can explore the results.</p><p>The data you load will be stored locally in a DuckDB database, by default <code>.dogsled/dogsled.duckdb</code> inside your project. You can query it directly with SQL or start DuckDB UI yourself if you want. Both are optional; the conversation and this page’s previews are enough to follow the tutorial.</p><ul><li>1. Connect to an API</li><li>2. Build an ETL pipeline</li><li>3. Build semantic models</li><li>4. Query your data</li><li>5. Query across sources</li><li>6. Build an agentic transformation</li><li>Optional: learn entity resolution using your watchlist</li></ul></section>`;
