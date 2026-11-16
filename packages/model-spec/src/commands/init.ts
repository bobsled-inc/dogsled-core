/**
 * `model init` command.
 *
 * Scaffolds a new project directory with example source and model files.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Command } from 'commander';

import { CONFIG_FILE_NAME } from '../config.js';
import * as out from '../output.js';

const EXAMPLE_SOURCE = `spec_version: "0.2"        # Required: spec format version
name: raw_users            # Unique name for this source
type: source               # Must be "source"
source_type: warehouse_table
connection: example        # Logical connection name (used in model refs)
table: raw.raw_users       # Fully-qualified table name in warehouse
description: Raw user data from the application database
trust_tier: bronze         # Data quality tier: bronze | silver | gold
schema:
  columns:
    - name: id
      type: INTEGER
      description: Primary key
    - name: email
      type: VARCHAR
      description: User email address
    - name: created_at
      type: TIMESTAMP
      description: Account creation timestamp
`;

const EXAMPLE_MODEL = `spec_version: "0.2"        # Required: spec format version
name: stg_users            # Model name (becomes the view/table name)
type: model                # Must be "model"
description: Staged users with cleaned fields
grain: user_id             # Business key / grain of the model
source:
  ref: example.raw_users   # Reference to source (connection.name)
columns:
  - name: user_id          # Output column name
    expr: t0.id            # Expression (t0 = source table alias)
    primary_key: true
  - name: email
    expr: LOWER(t0.email)  # Expressions support SQL functions
  - name: created_at
    expr: t0.created_at
materialization:
  type: view               # view | table | incremental | ephemeral
`;

const GITIGNORE = `.bobsled/model-spec/
dist/
`;

const DEFAULT_CONFIG = `# Model Spec project configuration.
#
# Warehouse credentials and dialect now live in integrations/<handle>.yml.
# Select the active integration with \`dogsled model compile --integration <handle>\`.

# sources_dir: sources             # Directory containing source spec files
# models_dir: models               # Directory containing model spec files
# seeds_dir: seeds                 # Directory containing seed spec files
# entity_graph_dir: entity-graph                     # Directory containing resolution spec files
# integrations_dir: integrations   # Directory containing integration spec files
# targets_dir: targets             # Directory containing target spec files
# metrics_dir: metrics             # First-class named measures (emitted as JSON
#                                  # alongside SQL via \`dogsled model compile --include-metadata\`)
# relationships_dir: relationships # Multi-column join descriptions between models
# vqs_dir: vqs                     # Verified-query NLQ-to-SQL pairings
`;

const EXAMPLE_INTEGRATION = `# Example DuckDB integration — credentials-free, runs locally.
# Replace with Snowflake/BigQuery/Postgres/Databricks as needed.
spec_version: "1"
type: integration
name: example
source_type: duckdb
connection:
  path: .bobsled/model-spec/warehouse.duckdb
auth:
  type: file
`;

const EXAMPLE_METRIC = `# A first-class named measure. Rendered to target/metrics.json when you
# pass \`dogsled model compile --include-metadata --output <dir>\`. The Data Estate
# UI surfaces these alongside the raw SQL.
spec_version: "0.2"
type: metric
name: users_total
description: Count of users in the staging model
expression: COUNT(*)
model: stg_users
tags: [example]
`;

const EXAMPLE_RELATIONSHIP = `# Relationships

Describes a join between two models. When you add a second model, create a
\`<name>.yml\` file here with the real relationship. Example:

\`\`\`yaml
spec_version: "0.2"
type: relationship
name: users_to_orders
left_model: stg_users
right_model: stg_orders
join_columns:
  - left: user_id
    right: customer_id
relationship_type: one_to_many
\`\`\`
`;

const EXAMPLE_VQ = `# A verified natural-language query. {ref} tokens resolve to models or
# sources at query time and are validated against the project at compile.
spec_version: "0.2"
type: vq
name: users_created_this_month
nlq: How many users signed up this month?
sql: |
  SELECT COUNT(*) AS users_this_month
  FROM {stg_users}
  WHERE DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE)
tags: [example]
`;

function initHandler(
  projectName: string | undefined,
  globalOptions: { verbose?: boolean; quiet?: boolean }
): void {
  const quiet = globalOptions.quiet ?? false;
  const dir = projectName ?? '.';

  const sourcesDir = path.join(dir, 'sources', 'example');
  const modelsDir = path.join(dir, 'models');
  const integrationsDir = path.join(dir, 'integrations');
  const metricsDir = path.join(dir, 'metrics');
  const relationshipsDir = path.join(dir, 'relationships');
  const vqsDir = path.join(dir, 'vqs');

  fs.mkdirSync(sourcesDir, { recursive: true });
  fs.mkdirSync(modelsDir, { recursive: true });
  fs.mkdirSync(integrationsDir, { recursive: true });
  fs.mkdirSync(metricsDir, { recursive: true });
  fs.mkdirSync(relationshipsDir, { recursive: true });
  fs.mkdirSync(vqsDir, { recursive: true });

  const sourceFile = path.join(sourcesDir, 'raw_users.yml');
  const modelFile = path.join(modelsDir, 'stg_users.yml');
  const integrationFile = path.join(integrationsDir, 'example.yml');
  const metricFile = path.join(metricsDir, 'users_total.yml');
  const relationshipFile = path.join(relationshipsDir, 'README.md');
  const vqFile = path.join(vqsDir, 'users_created_this_month.yml');

  const gitignoreFile = path.join(dir, '.gitignore');
  const configFile = path.join(dir, CONFIG_FILE_NAME);

  fs.writeFileSync(sourceFile, EXAMPLE_SOURCE, 'utf-8');
  fs.writeFileSync(modelFile, EXAMPLE_MODEL, 'utf-8');
  fs.writeFileSync(integrationFile, EXAMPLE_INTEGRATION, 'utf-8');
  fs.writeFileSync(metricFile, EXAMPLE_METRIC, 'utf-8');
  fs.writeFileSync(relationshipFile, EXAMPLE_RELATIONSHIP, 'utf-8');
  fs.writeFileSync(vqFile, EXAMPLE_VQ, 'utf-8');
  fs.writeFileSync(gitignoreFile, GITIGNORE, 'utf-8');
  fs.writeFileSync(configFile, DEFAULT_CONFIG, 'utf-8');

  if (!quiet) {
    out.success('Project initialized:');
    out.info(`  ${sourceFile}`);
    out.info(`  ${modelFile}`);
    out.info(`  ${integrationFile}`);
    out.info(`  ${metricFile}`);
    out.info(`  ${relationshipFile}`);
    out.info(`  ${vqFile}`);
    out.info(`  ${gitignoreFile}`);
    out.info(`  ${configFile}`);
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Scaffold a new project with example source and model files')
    .argument('[directory]', 'Project directory (default: current directory)')
    .action((projectName: string | undefined) => {
      const globalOptions = program.opts<{ verbose?: boolean; quiet?: boolean }>();
      initHandler(projectName, globalOptions);
    });
}
