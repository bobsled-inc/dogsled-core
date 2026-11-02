import type { TutorialDefinition } from '../../tutorial.js';
export const steps = [
  { id: 'connect', label: 'Connect your sources' },
  { id: 'load', label: 'Build an ETL pipeline' },
  { id: 'model', label: 'Build semantic models' },
  { id: 'query', label: 'Query product performance' },
  { id: 'federate', label: 'Query across sources' },
  { id: 'transform', label: 'Build an agentic transformation' },
];
export const lessons: TutorialDefinition['lessons'] = {
  connect: {
    learn:
      'Warehouse exports and customer feedback come from separate systems. Inspect a small API sample before loading data.',
    files: [
      'integrations/local_files.yml',
      'integrations/retail_api.yml',
      'sources/external_reviews.yml',
    ],
    choice: 'Choose a product question to investigate.',
    inspect: 'Check review IDs, product keys and pagination.',
  },
  load: {
    learn:
      'Load the seven CSV exports into local DuckDB while keeping feedback as a separate source.',
    files: ['resources/local_files/products.yml', 'integrations/warehouse.yml'],
    choice: 'Inspect products and order lines.',
    inspect: 'Compare all seven row counts with the fixture manifest.',
  },
  model: {
    learn:
      'Business definitions make metrics useful. Exclude cancelled orders, subtract refunds, and count each product-day once across stores.',
    files: [
      'models/product_performance.yml',
      'models/product_in_stock_days.yml',
      'models/product_sales_summary.yml',
    ],
    choice: 'Explain net sales and stock-day coverage in your own words.',
    inspect: 'Check one row per product and the ratio denominator.',
  },
  query: {
    learn:
      'Compare observed sales rates and stock coverage. These figures do not estimate lost demand or fully burdened profit.',
    files: ['models/product_performance.yml', 'metrics/net_sales.yml'],
    choice: 'Choose a product to investigate and explain why.',
    inspect: 'Compare the five leading products and their stock days.',
  },
  federate: {
    learn:
      'Join API reviews to warehouse products using product_id. A lazy source fetches then caches the API data. Support identity can remain unknown.',
    files: [
      'sources/external_reviews.yml',
      'models/product_review_summary.yml',
      'models/prepared_support_cases.yml',
    ],
    choice: 'Compare a customer review with sales and return evidence.',
    inspect: 'Inspect the lamp reviews and cases with null product identity.',
  },
  transform: {
    learn:
      'Use real AI to turn a small batch of support conversations into typed findings. A valid row still needs human evidence review.',
    files: ['models/support_batch.yml', 'models/support_case_classifications.yml', 'executor.mjs'],
    choice: 'Approve a provider and bounded batch, inspect one pilot, or skip AI.',
    inspect:
      'Read the exact support quote, product identity, issue and recorded resolution for each case.',
  },
};
export const descriptions = Object.fromEntries(
  steps.map((step) => [step.id, lessons[step.id]!.learn])
);
export const prompts = Object.fromEntries(
  steps.map((step) => [
    step.id,
    `Help me with the Retail tutorial chapter: ${step.label}. Explain the lesson, run only approved work, show the result, and pause for my review.`,
  ])
);
const commands: Record<string, [string, string][]> = {
  connect: [
    ['Inspect the API', 'dogsled source-query "SELECT * FROM sources.external_reviews LIMIT 5"'],
  ],
  load: [
    [
      'Load warehouse exports',
      'dogsled pipeline --integration local_files --dest duckdb --db-path data.duckdb',
    ],
  ],
  model: [
    ['Build product performance', 'dogsled model run +product_performance --integration warehouse'],
  ],
  query: [
    [
      'Compare products',
      'dogsled query "SELECT * FROM product_performance ORDER BY net_sales_per_in_stock_day DESC NULLS LAST LIMIT 5" --db-path data.duckdb',
    ],
  ],
  federate: [
    [
      'Prepare support evidence',
      'dogsled model run prepared_support_cases --integration warehouse',
    ],
  ],
  transform: [
    ['Check an approved pilot', 'dogsled onboarding verify transform --ticket-id case-0001'],
  ],
};
export const teaching = Object.fromEntries(
  steps.map((step) => [
    step.id,
    {
      code: commands[step.id]!,
      now: lessons[step.id]!.inspect,
      next: 'Inspect the saved evidence with your agent before moving on.',
      questions: [lessons[step.id]!.choice],
    },
  ])
);
export const planned = Object.fromEntries(steps.map((step) => [step.id, lessons[step.id]!.learn]));
