#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { CommandError } from '@bobsled-inc/protocol';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  magenta: (s) => `\x1b[35m${s}\x1b[0m`,
};

function parseArgs(argv) {
  const args = {
    cli: process.env.BOBSLED_CORE_CLI ?? 'dogsled',
    labDir: join(repoRoot, '.dogsled', 'tutor-lab'),
    list: false,
    reset: false,
    goto: null,
    auto: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--cli') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--'))
        throw new CommandError('--cli requires a command, for example: --cli "pnpm exec dogsled"');
      args.cli = value;
      index += 1;
    } else if (arg === '--lab-dir') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new CommandError('--lab-dir requires a path');
      args.labDir = isAbsolute(value) ? value : resolve(repoRoot, value);
      index += 1;
    } else if (arg === '--list') {
      args.list = true;
    } else if (arg === '--reset') {
      args.reset = true;
    } else if (arg === '--goto') {
      const value = argv[index + 1];
      if (!value) throw new CommandError('--goto requires a lesson number');
      const n = parseInt(value, 10);
      if (isNaN(n) || n < 1) throw new CommandError('--goto requires a positive integer');
      args.goto = n;
      index += 1;
    } else if (arg === '--auto') {
      args.auto = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exitCode = 0;
      return args;
    } else {
      throw new CommandError(`Unknown option: ${arg}`);
    }
  }

  return args;
}

const lessons = [
  {
    id: 'scope',
    title: 'Local Learning Scope',
    type: 'note',
    body: [
      'This tutor is for local understanding, not scheduling or deployment.',
      'It skips Vantage because those extracts can be slow and expensive for a learning pass.',
      'It skips GitHub Actions because the goal is to understand command shape and data flow locally.',
      'Live SaaS steps are optional and use small --limit samples where the extractor supports it.',
    ],
  },
  {
    id: 'cli-help',
    title: 'Find The Top-Level CLI Surface',
    cwd: 'repo',
    command: 'dogsled --help',
    why: 'Start by seeing the command groups Dogsled exposes from the unified CLI.',
    think:
      'Look for extract, load, pipeline, model, integrations, entity-graph, and context commands. Those are the major capability areas this walkthrough covers.',
  },
  {
    id: 'catalog-list',
    title: 'List Bundled Integrations',
    cwd: 'repo',
    command: 'dogsled integrations list',
    why: 'The integration catalog tells us which API sources are already available before we write anything.',
    think:
      'Notice the categories and resource counts. For this local pass, focus on HubSpot, Stripe, Linear, Pylon, and Smartlead. Vantage is intentionally skipped.',
  },
  {
    id: 'hubspot-catalog',
    title: 'Inspect HubSpot',
    cwd: 'repo',
    command: 'dogsled integrations show hubspot',
    why: 'HubSpot gives a compact CRM surface for contacts, companies, and deals.',
    think:
      'Read the auth setup and resource list. The command is metadata-only, so it does not call HubSpot.',
  },
  {
    id: 'hubspot-contacts-shape',
    title: 'Inspect HubSpot Contacts',
    cwd: 'repo',
    command: 'dogsled integrations show hubspot contacts',
    why: 'Resource details show endpoint shape and normalized output columns before extraction.',
    think:
      'The bundled contacts resource already maps selected HubSpot properties into flat fields. Custom properties still need deliberate resource configuration.',
  },
  {
    id: 'stripe-catalog',
    title: 'Inspect Stripe',
    cwd: 'repo',
    command: 'dogsled integrations show stripe',
    why: 'Stripe is useful for understanding finance and revenue-oriented resource specs.',
    think:
      'Look for customers, invoices, subscriptions, charges, prices, and products. Those are common raw inputs for revenue models.',
  },
  {
    id: 'linear-catalog',
    title: 'Inspect Linear',
    cwd: 'repo',
    command: 'dogsled integrations show linear',
    why: 'Linear exercises GraphQL and MCP-flavored resources, not just REST list endpoints.',
    think: 'Pay attention to the resource names. The issue resource is issues_graphql, not issues.',
  },
  {
    id: 'linear-issues-shape',
    title: 'Inspect Linear Issues',
    cwd: 'repo',
    command: 'dogsled integrations show linear issues_graphql',
    why: 'This shows the exact GraphQL-backed issue fields Dogsled exposes.',
    think:
      'The output columns include state, assignee, team, project, and timestamps. That is the shape you would model later.',
  },
  {
    id: 'pylon-catalog',
    title: 'Inspect Pylon',
    cwd: 'repo',
    command: 'dogsled integrations show pylon',
    why: 'Pylon gives the customer-support side of a GTM learning dataset.',
    think: 'Scan for accounts, contacts, feature_requests, issues, and support workflow tables.',
  },
  {
    id: 'smartlead-catalog',
    title: 'Inspect Smartlead',
    cwd: 'repo',
    command: 'dogsled integrations show smartlead',
    why: 'Smartlead gives a compact marketing-outreach surface.',
    think:
      'This is intentionally smaller than the other integrations, which makes it useful for a quick source-shape pass.',
  },
  {
    id: 'lab-note',
    title: 'Local Lab Directory',
    type: 'note',
    body: [
      'Commands that write files run in the lab directory.',
      'The default lab is .dogsled/tutor-lab, which is gitignored.',
      'You can change it with --lab-dir ./somewhere-else.',
    ],
  },
  {
    id: 'hubspot-limited-extract',
    title: 'Extract A Small HubSpot Sample',
    cwd: 'lab',
    env: ['HUBSPOT_ACCESS_TOKEN'],
    command:
      'dogsled extract run contacts --integration hubspot --limit 10 | dogsled load run --dest duckdb --db-path ./dev.duckdb --table-prefix hubspot__',
    why: 'This is the safest first live extract because --limit caps the protocol stream before loading it to local DuckDB.',
    think:
      'Read the extractor logs and loader summary. The key idea is that extract emits protocol messages and load consumes them without caring which source produced them.',
  },
  {
    id: 'hubspot-count',
    title: 'Query The Loaded HubSpot Table',
    cwd: 'lab',
    command:
      'dogsled load query "SELECT COUNT(*) AS contact_count FROM hubspot__contacts" --dest duckdb --db-path ./dev.duckdb',
    why: 'A load is not real until you can query the destination and explain what landed.',
    think:
      'The count should match the limited sample unless the source returned fewer rows. If the table does not exist, go back to the extract step.',
  },
  {
    id: 'hubspot-describe',
    title: 'Inspect The Loaded Schema',
    cwd: 'lab',
    command: 'dogsled load query "DESCRIBE hubspot__contacts" --dest duckdb --db-path ./dev.duckdb',
    why: 'Schema inspection connects the resource output spec to the destination table Dogsled created.',
    think:
      'Compare these columns to integrations show hubspot contacts. This is the raw material Model Spec models consume.',
  },
  {
    id: 'pipeline-caution',
    title: 'Pipeline Command Caution',
    type: 'note',
    body: [
      'The next command shows the high-level pipeline interface.',
      'Unlike extract run, pipeline does not currently expose a hard --limit flag.',
      'Use it only with a sandbox account or after you are comfortable with the resource size.',
    ],
  },
  {
    id: 'hubspot-pipeline-shape',
    title: 'Run The Pipeline Interface',
    cwd: 'lab',
    env: ['HUBSPOT_ACCESS_TOKEN'],
    command:
      'dogsled pipeline --integration hubspot --resource contacts --dest duckdb --db-path ./pipeline.duckdb --table-prefix hubspot_pipeline__ --input limit=25',
    why: 'Pipeline is the convenience command that wires extractor output directly into the loader.',
    think:
      'Use this to understand ergonomics, not to schedule anything. The --input limit=25 controls HubSpot page size, not total record count.',
  },
  {
    id: 'stripe-limited-extract',
    title: 'Extract A Small Stripe Sample',
    cwd: 'lab',
    env: ['STRIPE_SECRET_KEY'],
    command:
      'dogsled extract run customers --integration stripe --limit 10 | dogsled load run --dest duckdb --db-path ./dev.duckdb --table-prefix stripe__',
    why: 'Stripe customers let you compare CRM identity data with billing identity data.',
    think:
      'Watch for stable IDs, emails, created timestamps, and nested billing fields that may need modeling attention.',
  },
  {
    id: 'linear-limited-extract',
    title: 'Extract A Small Linear Sample',
    cwd: 'lab',
    env: ['LINEAR_API_KEY'],
    command:
      'dogsled extract run issues_graphql --integration linear --limit 10 | dogsled load run --dest duckdb --db-path ./dev.duckdb --table-prefix linear__',
    why: 'Linear issues exercise Dogsled GraphQL extraction and a developer-workflow data shape.',
    think:
      'Compare the output with the Linear resource detail. This should reinforce that resource names and output schemas are part of the contract.',
  },
  {
    id: 'pylon-limited-extract',
    title: 'Extract A Small Pylon Sample',
    cwd: 'lab',
    env: ['PYLON_API_TOKEN'],
    command:
      'dogsled extract run issues --integration pylon --limit 10 | dogsled load run --dest duckdb --db-path ./dev.duckdb --table-prefix pylon__',
    why: 'Pylon issues add customer-support data to the same local DuckDB destination.',
    think:
      'This is a good place to notice rate limits and how different SaaS products expose related customer concepts.',
  },
  {
    id: 'smartlead-limited-extract',
    title: 'Extract A Small Smartlead Sample',
    cwd: 'lab',
    env: ['SMARTLEAD_API_KEY'],
    command:
      'dogsled extract run campaigns --integration smartlead --limit 10 | dogsled load run --dest duckdb --db-path ./dev.duckdb --table-prefix smartlead__',
    why: 'Smartlead campaigns round out the GTM source tour with a compact marketing surface.',
    think:
      'If this is sparse or empty, that is still useful: it tells you which sources carry meaningful data in your account.',
  },
  // Section: Linear API End-to-End
  {
    id: 'linear-runner-validate',
    title: 'Validate the Linear Integration',
    cwd: 'lab',
    env: ['LINEAR_API_KEY'],
    command: 'dogsled extract run linear --validate',
    why: 'Validation checks the integration spec before hitting the API — catches auth and config issues early.',
    think:
      'Look for any missing required fields or auth configuration errors. A clean validate means the spec is ready to run.',
  },
  {
    id: 'linear-runner-run',
    title: 'Extract Linear Issues to DuckDB',
    cwd: 'lab',
    env: ['LINEAR_API_KEY'],
    command: 'dogsled extract run linear --limit 50 | dogsled load run --target duckdb',
    why: 'Full pipeline: extract 50 records from the Linear API, pipe the protocol stream to the DuckDB loader.',
    think:
      'Watch for RECORD and SCHEMA messages flowing through the protocol pipe. The loader consumes them without knowing which source produced them.',
  },
  {
    id: 'linear-model-run',
    title: 'Run the Linear Model Spec Stack',
    cwd: 'lab',
    command: 'dogsled model run --dialect duckdb',
    why: 'Runs the full Model Spec model stack: issues → comments → users → derived tables.',
    think:
      'This transforms raw Linear protocol output into structured, queryable analytics tables. Each model in the DAG reads from the previous one.',
  },
  {
    id: 'linear-query-results',
    title: 'Query Linear Issue Counts by State',
    cwd: 'lab',
    command:
      'dogsled load query "SELECT state, COUNT(*) AS cnt FROM main.linear_issues GROUP BY state ORDER BY cnt DESC" --target duckdb',
    why: 'Shows live results from the materialized data — demonstrating the end-to-end API→model→query flow.',
    think:
      'This is the payoff: raw GraphQL API data modeled into a queryable table, all locally in DuckDB.',
  },
  // Section: Incremental Load Demo
  {
    id: 'incremental-note',
    title: 'Incremental Load with Merge Strategy',
    type: 'note',
    body: [
      'The merge strategy deduplicates records by primary key on each load.',
      'Running the same extract twice will not create duplicate rows.',
      'The next three steps demonstrate: first load → count → second overlapping load → recount.',
      'Use this pattern when source APIs expose updated records alongside new ones.',
    ],
  },
  {
    id: 'incremental-first-load',
    title: 'First Incremental Load (25 records)',
    cwd: 'lab',
    env: ['LINEAR_API_KEY'],
    command:
      'dogsled extract run linear --limit 25 | dogsled load run --target duckdb --strategy merge',
    why: 'First batch: 25 records loaded with merge strategy. This seeds the destination table.',
    think:
      'The merge strategy requires a primary key column. Dogsled infers it from the resource spec.',
  },
  {
    id: 'incremental-count-before',
    title: 'Count Before Second Load',
    cwd: 'lab',
    command:
      'dogsled load query "SELECT COUNT(*) AS total FROM main.linear_issues" --target duckdb',
    why: 'Capture the row count after the first load to verify the second load does not create duplicates.',
    think:
      'Write down the count. After the second load you will verify it either stays the same or grows — never doubles.',
  },
  {
    id: 'incremental-second-load',
    title: 'Second Incremental Load (50 records, overlapping)',
    cwd: 'lab',
    env: ['LINEAR_API_KEY'],
    command:
      'dogsled extract run linear --limit 50 | dogsled load run --target duckdb --strategy merge',
    why: 'Second batch with overlap: 50 records where the first 25 already exist. Merge deduplicates.',
    think:
      'Run the count query again after this step. The total should be ≥25 but never duplicated. That is merge semantics.',
  },
  // Model Spec Shop Demo
  {
    id: 'shop-demo-readme',
    title: 'Read The Model Spec Demo Map',
    cwd: 'shop',
    command: "sed -n '1,120p' README.md",
    why: 'The shop demo is a credential-free local Model Spec project with seeds, sources, models, metrics, relationships, and VQs.',
    think:
      'Use it to learn Model Spec concepts without waiting on SaaS APIs or warehouse credentials.',
  },
  {
    id: 'shop-demo-rebuild',
    title: 'Build The Local Model Spec Demo',
    cwd: 'shop',
    command: 'pnpm exec tsx rebuild-demo.ts',
    why: 'This seeds DuckDB and materializes the demo model DAG.',
    think:
      'Treat this as a local data warehouse setup. The later model commands inspect and validate what this command created.',
  },
  {
    id: 'shop-demo-validate',
    title: 'Validate Model Spec Specs',
    cwd: 'shop',
    command: 'dogsled model validate --integration duckdb',
    why: 'Validation catches spec shape, references, and compiler-facing issues before runtime.',
    think: 'This is the deterministic gate you want before asking an agent to modify models.',
  },
  {
    id: 'shop-demo-compile',
    title: 'Compile One Model',
    cwd: 'shop',
    command: 'dogsled model compile stg_customers --integration duckdb',
    why: 'Compilation shows the SQL Model Spec generates for a specific dialect.',
    think:
      'Look for cleaning functions and source references. This is where declarative YAML becomes warehouse SQL.',
  },
  {
    id: 'shop-demo-lineage',
    title: 'Inspect Model Lineage',
    cwd: 'shop',
    command: 'dogsled model lineage fct_orders --integration duckdb',
    why: 'Lineage explains model dependencies and helps you reason about blast radius.',
    think:
      'Trace fct_orders back to staging models and raw sources. That is the same mental model you need for GTM marts.',
  },
  {
    id: 'shop-demo-expect',
    title: 'Run Model Expectations',
    cwd: 'shop',
    command:
      'dogsled model expect run --model stg_customers --integration duckdb --runner ./runner.duckdb.js',
    why: 'Expectations are executable data contracts, not just documentation.',
    think:
      'Read any passing or failing expectation as evidence about the data, model logic, or contract definition.',
  },
  {
    id: 'shop-demo-metadata',
    title: 'Compile Metadata Artifacts',
    cwd: 'shop',
    command: 'dogsled model compile --integration duckdb --include-metadata -o .dogsled-tutor-sql',
    why: 'Metadata output shows how metrics, relationships, entity relationships, and VQs travel alongside SQL.',
    think:
      'Open .dogsled-tutor-sql after this if you want to inspect generated SQL and metadata files.',
  },
  {
    id: 'shop-demo-vq-inspect',
    title: 'Inspect A Local VQ Spec',
    cwd: 'shop',
    command: "sed -n '1,120p' vqs/revenue_by_month.yml",
    why: 'Verified queries encode known-good analytical questions and SQL patterns.',
    think:
      'The shop-demo VQs use model tokens, so they are best understood here as semantic artifacts emitted by compile metadata. The current dogsled vq run command is narrower and supports source-token VQs.',
  },
  // Entity Graph
  {
    id: 'entity-readme',
    title: 'Read The Entity Graph Demo',
    cwd: 'entity',
    command: "sed -n '1,140p' README.md",
    why: 'The customer-resolution fixture is a local identity-resolution lab with synthetic data.',
    think:
      'Look for the pipeline stages: standardize, block, score, threshold, review, cluster, crosswalk, survivorship, and truthset.',
  },
  {
    id: 'entity-run',
    title: 'Run Local Entity Resolution',
    cwd: 'entity',
    command: 'bash scripts/run.sh --mode illustrative --dialect duckdb',
    why: 'This runs the local DuckDB entity-graph workflow end to end without BigQuery or GitHub Actions.',
    think:
      'Read the generated tables and review decisions in the output. The goal is to explain why records did or did not resolve together.',
  },
  {
    id: 'entity-build',
    title: 'Compile the Customer Entity Graph',
    cwd: 'entity',
    command: 'entity-graph build customer',
    why: 'Compiles the customer entity graph spec and shows the full DAG of SQL resolution steps.',
    think:
      'Read the step names and their order. Each step is a transformation: standardize → block → score → threshold → cluster.',
  },
  {
    id: 'entity-status',
    title: 'Check Entity Resolution Status',
    cwd: 'entity',
    command: 'entity-graph resolve status customer --runner runner.duckdb.js',
    why: 'Shows the resolution status table: pairs scored, review queue depth, and clusters formed.',
    think:
      'Status is a diagnostic view. Use it to understand whether the resolution pipeline has run and whether it needs re-scoring.',
  },
  {
    id: 'entity-audit',
    title: 'Audit Resolution Decisions',
    cwd: 'entity',
    command: 'entity-graph review audit customer --runner runner.duckdb.js',
    why: 'Surfaces the audit log of review decisions: reviewer, confidence, and timestamp.',
    think:
      'The audit log is the paper trail for why specific records were resolved together or kept separate.',
  },
  {
    id: 'entity-agent-handoff',
    title: 'Claude Code Agent Handoff Pattern',
    type: 'note',
    body: [
      'The customer-resolution-claude-code/ variant demonstrates the agent handoff pattern.',
      'Instead of a human reviewer triaging pairs, a Claude Code agent proposes and applies merge decisions.',
      'The agent reads the scored pairs, applies confidence thresholds, and writes decisions back to the review table.',
      `See: packages/model-spec/tests/integration/customer-resolution-claude-code/`,
    ],
  },
  // BigQuery (Optional)
  {
    id: 'bigquery-note',
    title: 'BigQuery (Optional)',
    type: 'note',
    body: [
      'The following lessons require BigQuery credentials and a configured project.',
      'Type skip at each prompt to skip this section.',
      'Set GOOGLE_CLOUD_PROJECT, BIGQUERY_DATASET, and ensure Application Default Credentials are configured.',
    ],
  },
  {
    id: 'bigquery-check',
    title: 'Check BigQuery Connectivity',
    cwd: 'lab',
    env: ['GOOGLE_CLOUD_PROJECT'],
    command: 'dogsled load check --target bigquery',
    why: 'Validates BigQuery connectivity before attempting a load.',
    think: 'A passing check means credentials are configured and the target dataset is reachable.',
  },
  {
    id: 'bigquery-load',
    title: 'Load Linear Data to BigQuery',
    cwd: 'lab',
    env: ['GOOGLE_CLOUD_PROJECT', 'LINEAR_API_KEY'],
    command: 'dogsled extract run linear --limit 50 | dogsled load run --target bigquery',
    why: 'Loads Linear data to BigQuery — same protocol pipe, different destination target.',
    think:
      'The protocol stream is destination-agnostic. Swapping DuckDB for BigQuery only changes the --target flag.',
  },
  {
    id: 'bigquery-query',
    title: 'Query BigQuery Linear Issues',
    cwd: 'lab',
    env: ['GOOGLE_CLOUD_PROJECT'],
    command: 'dogsled load query "SELECT COUNT(*) FROM linear_issues" --target bigquery',
    why: 'Shows live BigQuery query results — same query pattern as DuckDB, warehouse-scale destination.',
    think:
      'Compare this output with the DuckDB equivalent. Same data, same query, warehouse-scale destination.',
  },
  {
    id: 'wrap-up',
    title: 'Wrap Up',
    type: 'note',
    body: [
      'At this point you have inspected source specs, run limited local extracts, loaded DuckDB tables, exercised Model Spec locally, run Entity Graph locally, and seen the BigQuery destination pattern.',
      'The next iteration should capture questions and friction as concrete follow-up issues or docs notes.',
      'Vantage and GitHub Actions can come later after the local shape is clear.',
    ],
  },
];

function printHelp() {
  console.log(`Dogsled capability tutor

Usage:
  node scripts/dogsled-capability-tutor.mjs [options]

Options:
  --cli <command>      Command used when executing canonical "dogsled ..." steps.
                       Default: BOBSLED_CORE_CLI or dogsled
  --lab-dir <path>    Directory for local DuckDB files and tutor progress.
                       Default: .dogsled/tutor-lab
  --list              Print lesson list and exit
  --reset             Clear saved tutor progress before starting
  --goto <n>          Jump to lesson number N (skips prior lessons)
  --auto              Auto-advance 1.5s after each successful command
  -h, --help          Show this help

Examples:
  node scripts/dogsled-capability-tutor.mjs
  BOBSLED_CORE_CLI="pnpm exec dogsled" node scripts/dogsled-capability-tutor.mjs
  node scripts/dogsled-capability-tutor.mjs --cli "pnpm exec dogsled"
  node scripts/dogsled-capability-tutor.mjs --reset
  node scripts/dogsled-capability-tutor.mjs --goto 13
  node scripts/dogsled-capability-tutor.mjs --auto
`);
}

function cwdFor(lesson, labDir) {
  const locations = {
    entity: join(repoRoot, 'packages', 'model-spec', 'tests', 'integration', 'customer-resolution'),
    'entity-cc': join(
      repoRoot,
      'packages',
      'model-spec',
      'tests',
      'integration',
      'customer-resolution-claude-code'
    ),
    lab: labDir,
    repo: repoRoot,
    shop: join(repoRoot, 'workspace', 'shop-demo'),
  };
  const key = lesson.cwd ?? 'repo';
  const location = locations[key];
  if (!location) throw new CommandError(`Unknown lesson cwd key: ${key}`);
  return location;
}

function labelForCwd(lesson, labDir) {
  const cwd = cwdFor(lesson, labDir);
  return cwd.replace(`${repoRoot}/`, '');
}

function executableCommand(command, cli) {
  return command.replace(/(^|[|;&]\s*)dogsled(?=\s|$)/g, (_match, prefix) => `${prefix}${cli}`);
}

function normalizeCommand(command) {
  return command.trim().replace(/\s+/g, ' ');
}

function loadProgress(progressPath) {
  if (!existsSync(progressPath)) return { completed: {}, skipped: {} };
  try {
    const parsed = JSON.parse(readFileSync(progressPath, 'utf8'));
    return {
      completed: parsed.completed ?? {},
      skipped: parsed.skipped ?? {},
    };
  } catch {
    return { completed: {}, skipped: {} };
  }
}

function saveProgress(progressPath, progress) {
  writeFileSync(
    progressPath,
    `${JSON.stringify({ ...progress, updatedAt: new Date().toISOString() }, null, 2)}\n`
  );
}

const SECTION_PATTERNS = [
  [
    /^(scope|cli-|catalog-|hubspot-catalog|hubspot-contacts|stripe-catalog|linear-catalog|linear-issues|pylon-catalog|smartlead-catalog)/,
    'CLI & Catalog',
  ],
  [
    /^(lab-|hubspot-limited|hubspot-count|hubspot-describe|pipeline|hubspot-pipeline|stripe-limited|linear-limited|pylon-limited|smartlead-limited)/,
    'Extract & Load',
  ],
  [/^(linear-runner|linear-model|linear-query|incremental)/, 'Linear API End-to-End'],
  [/^shop-/, 'Model Spec Shop Demo'],
  [/^entity-/, 'Entity Graph'],
  [/^bigquery/, 'BigQuery (Optional)'],
  [/^wrap-up$/, 'Wrap Up'],
];

function sectionFor(id) {
  for (const [pattern, name] of SECTION_PATTERNS) {
    if (pattern.test(id)) return name;
  }
  return '';
}

function printLesson(index, total, lesson, labDir) {
  const pct = Math.round(((index + 1) / total) * 100);
  console.log('\n' + '='.repeat(72));
  console.log(`${c.cyan(`[${index + 1}/${total} · ${pct}%]`)} ${c.bold(lesson.title)}`);
  console.log('='.repeat(72));
  if (lesson.body) {
    for (const line of lesson.body) console.log(line);
  }
  if (lesson.cwd) console.log(`\nWorking directory: ${labelForCwd(lesson, labDir)}`);
  if (lesson.env?.length) {
    const missing = lesson.env.filter((name) => !process.env[name]);
    console.log(`Required env: ${lesson.env.join(', ')}`);
    if (missing.length) {
      console.log(c.yellow(`Missing env: ${missing.join(', ')}`));
      console.log('Set these in the shell before starting the tutor, or skip this step for now.');
    }
  }
  if (lesson.command) {
    console.log('\nCommand to type:');
    console.log(c.cyan(lesson.command));
  }
  if (lesson.commands) {
    console.log('\nCommands to run in sequence:');
    for (const [i, cmd] of lesson.commands.entries()) {
      console.log(c.cyan(`  ${i + 1}. ${cmd}`));
    }
  }
  if (lesson.why) console.log(`\nWhat it does:\n${lesson.why}`);
  if (lesson.think) console.log(`\nHow to think about it:\n${lesson.think}`);
}

async function runShellCommand(command, cwd) {
  return new Promise((resolveCommand) => {
    const child = spawn(command, {
      cwd,
      env: process.env,
      shell: process.env.SHELL ?? '/bin/sh',
      stdio: 'inherit',
    });
    child.on('close', (code) => resolveCommand(code ?? 1));
    child.on('error', () => resolveCommand(1));
  });
}

async function waitOrEnter(rl, ms) {
  process.stdout.write(
    c.dim(`\n  → auto-advancing in ${ms / 1000}s… (press Enter to skip delay)\n`)
  );
  const controller = new AbortController();
  await new Promise((resolve) => {
    const timerId = setTimeout(() => {
      controller.abort();
      resolve();
    }, ms);
    rl.question('', { signal: controller.signal }).then(
      () => {
        clearTimeout(timerId);
        resolve();
      },
      () => {
        // aborted by timer — timer already called resolve()
      }
    );
  });
}

const CONTROLS = new Set(['run', 'skip', 'quit', 'q', 'back', 'b']);

function looksLikeCommand(answer) {
  return answer.length > 0 && !CONTROLS.has(answer);
}

async function runNote(rl, index, total, lesson, labDir, progress, progressPath) {
  printLesson(index, total, lesson, labDir);
  const answer = (await rl.question('\nPress Enter to continue, or type back/skip/quit: ')).trim();
  if (answer === 'quit' || answer === 'q') return 'quit';
  if (answer === 'back' || answer === 'b') return 'back';
  if (answer === 'skip') {
    progress.skipped[lesson.id] = new Date().toISOString();
  } else {
    progress.completed[lesson.id] = new Date().toISOString();
  }
  saveProgress(progressPath, progress);
  return 'continue';
}

async function runSingleCommand(rl, rendered, executable, cli, lessonCwd) {
  while (true) {
    console.log('\nShortcuts: run, back, skip, quit');
    const answer = (await rl.question('\nType the command: ')).trim();

    if (answer === 'quit' || answer === 'q') return { result: 'quit' };
    if (answer === 'back' || answer === 'b') return { result: 'back' };
    if (answer === 'skip') return { result: 'skip' };

    const normalizedAnswer = normalizeCommand(answer);
    const typedCanonical = normalizedAnswer === normalizeCommand(rendered);
    const typedExecutable = normalizedAnswer === normalizeCommand(executable);
    const isRun = answer === 'run';

    if (!isRun && !looksLikeCommand(answer)) {
      console.log('\nType the command, type run to execute it, or use back/skip/quit.');
      continue;
    }

    let commandToRun;
    if (typedExecutable) {
      commandToRun = answer;
    } else if (typedCanonical || isRun) {
      commandToRun = executable;
    } else {
      commandToRun = executableCommand(answer, cli);
      console.log('\nNote: running your command (differs from the lesson command).');
    }

    console.log(`\nRunning:\n${commandToRun}\n`);
    const code = await runShellCommand(commandToRun, lessonCwd);
    if (code === 0) return { result: 'ok' };

    console.log(c.red(`\nCommand exited with code ${code}.`));
    const next = (await rl.question('Type retry, back, skip, or quit: ')).trim();
    if (next === 'quit' || next === 'q') return { result: 'quit' };
    if (next === 'back' || next === 'b') return { result: 'back' };
    if (next === 'skip') return { result: 'skip' };
    // 'retry' or anything else → loop again
  }
}

async function runCommandLesson(
  rl,
  index,
  total,
  lesson,
  labDir,
  cli,
  auto,
  progress,
  progressPath
) {
  const commands = lesson.commands ?? [lesson.command];
  const lessonCwd = cwdFor(lesson, labDir);

  for (let cmdIndex = 0; cmdIndex < commands.length; cmdIndex++) {
    const rendered = commands[cmdIndex];
    const executable = executableCommand(rendered, cli);

    printLesson(index, total, lesson, labDir);
    if (commands.length > 1) {
      console.log(c.dim(`\nStep ${cmdIndex + 1}/${commands.length}:`));
      console.log(c.cyan(rendered));
    }

    const { result } = await runSingleCommand(rl, rendered, executable, cli, lessonCwd);
    if (result === 'quit') return 'quit';
    if (result === 'back') return 'back';
    if (result === 'skip') {
      progress.skipped[lesson.id] = new Date().toISOString();
      saveProgress(progressPath, progress);
      return 'continue';
    }
    // result === 'ok' → continue to next command
  }

  progress.completed[lesson.id] = new Date().toISOString();
  delete progress.skipped[lesson.id];
  saveProgress(progressPath, progress);
  if (auto) await waitOrEnter(rl, 1500);
  return 'continue';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (process.exitCode !== undefined) return;

  mkdirSync(args.labDir, { recursive: true });
  const progressPath = join(args.labDir, '.dogsled-tutor-progress.json');

  if (args.reset && existsSync(progressPath)) rmSync(progressPath);
  const progress = loadProgress(progressPath);

  const total = lessons.length;

  if (args.list) {
    let currentSection = '';
    for (const [index, lesson] of lessons.entries()) {
      const section = sectionFor(lesson.id);
      if (section !== currentSection) {
        currentSection = section;
        if (section) {
          const bar = '─'.repeat(Math.max(0, 50 - section.length));
          console.log(`\n${c.bold(c.cyan(`─── ${section} ${bar}`))}`);
        }
      }
      const isDone = progress.completed[lesson.id];
      const isSkipped = progress.skipped[lesson.id];
      const icon = isDone ? c.green('✓') : isSkipped ? c.yellow('⊘') : c.dim('○');
      const num = String(index + 1).padStart(2, '0');
      const label = isDone
        ? c.green(`${num} ${lesson.id}: ${lesson.title}`)
        : isSkipped
          ? c.yellow(`${num} ${lesson.id}: ${lesson.title}`)
          : c.dim(`${num} ${lesson.id}: ${lesson.title}`);
      console.log(`${icon} ${label}`);
    }
    return;
  }

  console.log(c.bold('Dogsled Capability Tutor'));
  console.log(`Repo: ${repoRoot}`);
  console.log(`Lab:  ${args.labDir}`);
  console.log(`CLI:  ${args.cli}`);
  if (args.auto) console.log(c.dim('Auto-advance: on (1.5s delay after successful commands)'));
  console.log('Progress is saved after each lesson. Use --reset to start over.');

  if (args.goto !== null && args.goto > total) {
    throw new CommandError(`--goto must be between 1 and ${total}`);
  }
  const startIndex = args.goto !== null ? args.goto - 1 : 0;
  if (startIndex > 0) {
    console.log(c.dim(`\nJumping to lesson ${startIndex + 1}…`));
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let index = startIndex;
  try {
    while (index < lessons.length) {
      const lesson = lessons[index];

      if (progress.completed[lesson.id] || progress.skipped[lesson.id]) {
        const status = progress.completed[lesson.id] ? c.green('completed') : c.yellow('skipped');
        console.log(`${c.dim(String(index + 1).padStart(2, '0'))} ${lesson.title} (${status})`);
        index += 1;
        continue;
      }

      const result =
        lesson.type === 'note'
          ? await runNote(rl, index, total, lesson, args.labDir, progress, progressPath)
          : await runCommandLesson(
              rl,
              index,
              total,
              lesson,
              args.labDir,
              args.cli,
              args.auto,
              progress,
              progressPath
            );

      if (result === 'quit') {
        console.log(`\nStopped. Resume later with: node scripts/dogsled-capability-tutor.mjs`);
        break;
      }

      if (result === 'back') {
        if (index === 0) {
          console.log('Already at the first lesson.');
          continue;
        }
        const prevIndex = index - 1;
        const prevLesson = lessons[prevIndex];
        delete progress.completed[prevLesson.id];
        delete progress.skipped[prevLesson.id];
        saveProgress(progressPath, progress);
        index = prevIndex;
        continue;
      }

      index += 1;
    }
  } finally {
    rl.close();
  }

  if (index >= lessons.length) console.log(c.green('\nTutor complete.'));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof CommandError ? error.exitCode : 1;
});
