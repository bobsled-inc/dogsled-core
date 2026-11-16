import { UNIFIED_INGEST_MODULE } from './learn-module-unified-ingest';
import { ENTITY_GRAPH_SDK_MODULE } from './learn-module-entity-graph-sdk';
import type { LearnModule } from './learn-curriculum';
import { command, terminalAction } from './learn-module-helpers';

export const LEARN_MODULES: LearnModule[] = [
  {
    id: 'foundations',
    title: 'Bobsled Core Foundations',
    group: 'foundations',
    description:
      'Build the mental model for Bobsled Core projects, commands, specs, and Explorer surfaces.',
    outcome:
      'You can move between CLI help, generated examples, Explorer catalogs, and local data.',
    estimatedMinutes: 18,
    cliPhaseIds: ['welcome', 'project-shape', 'cli-map'],
    steps: [
      {
        id: 'protocol-first',
        kind: 'concept',
        title: 'Start with the protocol',
        body: 'Bobsled Core components compose through structured messages: extractors emit SCHEMA, RECORD, and STATE events on stdout; loaders and tools consume them from stdin. This separation means you can pipe any extractor into any loader without coupling them. Every CLI command in Bobsled Core either produces or consumes this stream.',
        cliLessonId: 'welcome.protocol',
      },
      {
        id: 'inspect-cli',
        kind: 'command',
        title: 'Browse CLI examples',
        body: 'The `examples list` command prints every built-in runnable example grouped by category — extraction, loading, entity graph, pipeline, and MCP. Each entry shows the command, a short description, and which flags are relevant. Browsing this list gives you the fastest mental map of what Bobsled Core can do before you start configuring your own pipelines.',
        cliLessonId: 'cli-map.help',
        command: command('examples', ['list']),
        action: terminalAction('Open Examples', command('examples', ['list'])),
      },
      {
        id: 'browse-catalogs',
        kind: 'surface',
        title: 'Browse Explorer catalogs',
        body: 'The Integrations catalog lists every pre-built extraction spec. Each entry shows the transport (REST, GraphQL, warehouse, MCP), available resources, and the auth method — no credentials needed to browse. Models shows all pre-built Model Spec bundles. Both catalogs are generated from the same YAML specs your pipelines use.',
        action: { label: 'Open Integrations', href: '/integrations', autoCompletes: true },
      },
      {
        id: 'check-zero-credentials',
        kind: 'concept',
        title: 'The zero-credential path',
        body: 'Most Learn modules work entirely against committed demo data and local metadata — no API keys required. Modules that need real credentials are tagged "credentials optional" and fall back to structural inspection when keys are absent. The credential check API only returns whether a variable is present, never its value.',
      },
    ],
  },
  {
    id: 'bobsled-model-spec-context',
    title: 'Model Spec and Context as Code',
    group: 'bobsled-model-spec-context',
    description: 'Connect model specs, semantic context, verified queries, and data previews.',
    outcome:
      'You can inspect model DAGs, compiled SQL, semantic artifacts, and queryable demo tables.',
    estimatedMinutes: 24,
    cliPhaseIds: ['model-foundations', 'semantic-context', 'verified-queries'],
    steps: [
      {
        id: 'open-modeling',
        kind: 'surface',
        title: 'Open Modeling',
        body: "Modeling shows all available Model Spec (Model Spec) bundles — pre-built YAML-driven models that compile to multi-dialect SQL. The overview lists each bundle's name, the entities it owns, and which warehouse dialects it supports. Start here to understand the scope of what's available before drilling into a specific bundle's columns and join paths.",
        action: { label: 'Open Modeling', href: '/modeling', autoCompletes: true },
      },
      {
        id: 'inspect-shop-model',
        kind: 'spec',
        title: 'Inspect the Shop demo model',
        body: 'Open the Shop models surface and pick any bundle. Look for three things: entity definitions (the top-level tables the model owns), column specs (types, descriptions, and whether a column is a measure or dimension), and join paths (how the model connects to related entities). The model graph renders these relationships visually — compare it with the raw YAML to build the mental mapping.',
        action: { label: 'Open Shop Models', href: '/demo/shop/models', autoCompletes: true },
      },
      {
        id: 'query-shop',
        kind: 'query',
        title: 'Run a verified-query style inspection',
        body: 'The Shop demo has pre-loaded DuckDB tables. Copy the SQL below, open the Shop queries surface, paste it into the editor, and run it. This is the same inspection pattern agents use when validating model outputs before promoting a verified query.',
        sql: 'SELECT * FROM main.orders LIMIT 25',
        action: { label: 'Open Shop Queries', href: '/demo/shop/queries', autoCompletes: true },
      },
      {
        id: 'context-artifacts',
        kind: 'concept',
        title: 'Map context files to agent behavior',
        body: 'Four files compose the context layer: semantic_model.yml (entities, joins, metrics), verified_queries.yml (pre-approved SQL patterns), system_prompt.md (agent instructions), and settings.yml (defaults like dialect and schema). Agents read all four at query time — changing any file immediately affects query generation without redeployment.',
        cliLessonId: 'semantic-context.artifacts',
      },
    ],
  },
  {
    id: 'entity-graph-deep-dive',
    title: 'Entity Graph Deep Dive',
    group: 'entity-graph',
    description:
      'Walk through resolution, review, clustering, survivorship, and every major output table.',
    outcome: 'You can explain the full output pipeline and know where to inspect each artifact.',
    estimatedMinutes: 36,
    cliPhaseIds: ['entity-graph-standardize', 'entity-graph-review', 'entity-graph-survivorship'],
    steps: [
      {
        id: 'design-resolution',
        kind: 'surface',
        title: 'Design the resolution spec',
        body: 'The resolution spec has four sections. First, entity_type names the primary table (e.g. company). Second, blocking_rules define which record pairs are even compared — they restrict the candidate set by fast exact-match criteria like domain or country before scoring begins. Third, scoring_rules assign weights to individual field comparisons (name, address, phone) using fuzzy matchers like jaro_winkler or exact. Fourth, thresholds set the accept and review cutoffs: pairs scoring above accept are automatically merged, pairs between accept and review land in the human queue, and pairs below are rejected. Open the design surface to see these sections live in the editor.',
        action: {
          label: 'Open Entity Graph Design',
          href: '/entity-graph/design',
          autoCompletes: true,
        },
      },
      {
        id: 'inspect-review-queue',
        kind: 'table',
        title: 'Inspect the review queue',
        body: 'Use the table atlas to inspect ambiguous pairs and see missing-table states when a workspace has not been seeded.',
        tableSuffix: '__review_queue',
        action: {
          label: 'Open Review Queue Sample',
          href: '/api/learn/entity-graph/table?scenario=default&entity=company&suffix=__review_queue',
          autoCompletes: true,
        },
      },
      {
        id: 'inspect-components',
        kind: 'table',
        title: 'Trace components into clusters',
        body: 'Components explain how accepted edges become cluster membership before crosswalk outputs are emitted. Each row in __components maps a source record to its cluster_id. Open the Entity Graph data surface to query this table directly after a resolve run.',
        tableSuffix: '__components',
        action: {
          label: 'Open Entity Graph Data',
          href: '/entity-graph/data',
          autoCompletes: true,
        },
      },
      {
        id: 'inspect-survivorship',
        kind: 'table',
        title: 'Trace golden records',
        body: 'Golden record, golden history, and survivorship audit tables explain selected mastered values. The __golden_record table has one row per cluster with the winning value for each field. Open Entity Graph data and query it to see which source record won each attribute.',
        tableSuffix: '__golden_record',
        action: {
          label: 'Open Entity Graph Data',
          href: '/entity-graph/data',
          autoCompletes: true,
        },
      },
      {
        id: 'run-resolution',
        kind: 'command',
        title: 'Run the local pipeline',
        body: 'The full Entity Graph pipeline runs four sub-steps in sequence: (1) resolve run — scores candidate pairs and writes accept/review/reject decisions to __review_decisions; (2) resolve cluster — traces accepted edges into connected components and writes cluster_ids to __components; (3) resolve profile — aggregates each cluster into summary statistics written to entity_profile; (4) survivorship run — applies field selection rules to pick winning values for each attribute, writing the output to __golden_record and __golden_history. Watch the SSE log for PROGRESS messages that confirm each sub-step completes before the next begins.',
        cliLessonId: 'entity-graph-run.resolve',
        command: command('entity-graph', [
          'resolve',
          'run',
          'workspace/entity-graph-demo/entity-graph/company_resolution.yml',
        ]),
        action: terminalAction(
          'Open Resolve Command',
          command('entity-graph', [
            'resolve',
            'run',
            'workspace/entity-graph-demo/entity-graph/company_resolution.yml',
          ])
        ),
      },
    ],
  },
  ENTITY_GRAPH_SDK_MODULE,
  {
    id: 'mcp-extraction',
    title: 'MCP Extraction',
    group: 'mcp-extraction',
    description: 'Learn how Bobsled Core treats MCP tools as structured extraction resources.',
    outcome: 'You can identify MCP transports, pagination, auth, and sandbox fallback paths.',
    estimatedMinutes: 38,
    cliPhaseIds: ['mcp-client', 'mcp-pagination', 'mcp-auth'],
    credentialEnvVars: ['MCP_SERVER_URL', 'MCP_BEARER_TOKEN'],
    steps: [
      {
        id: 'mcp-concept',
        kind: 'concept',
        title: 'Tool calls as resources',
        body: 'MCP (Model Context Protocol) is an open standard for exposing tools to AI agents and automation clients. In Bobsled Core, MCP resources define tool_name and arguments instead of HTTP endpoints. The extractor calls the MCP server using this protocol and emits the same SCHEMA/RECORD/STATE messages as a REST extraction. This means the same loader and pipeline machinery works regardless of transport — swap the integration YAML and the rest is unchanged.',
      },
      {
        id: 'mcp-transport',
        kind: 'concept',
        title: 'Transports: stdio vs SSE',
        body: 'Bobsled Core supports two MCP transports. stdio launches a local process and communicates over stdin/stdout — useful for running a local MCP server during development. SSE connects to a remote server over HTTP Server-Sent Events using a bearer token. The integration YAML specifies which transport via the transport.type field.',
      },
      {
        id: 'mcp-pagination',
        kind: 'concept',
        title: 'Pagination and cursors with MCP',
        body: 'MCP tools that return paginated results pass a next_cursor in their output. Bobsled Core reads this cursor, stores it in a STATE message, and passes it as an argument on the next tool call. On incremental runs, the extractor resumes from the stored cursor rather than re-fetching all records.',
      },
      {
        id: 'credential-check',
        kind: 'check',
        title: 'Check credential availability',
        body: 'Explorer can show whether MCP_SERVER_URL and MCP_BEARER_TOKEN are set in your environment, but it never returns their values. If they are absent, the sandbox fallback path uses the committed demo fixture instead of calling a live server.',
        action: {
          label: 'Check MCP Credentials',
          href: '/api/learn/credentials?module=mcp-extraction',
          autoCompletes: true,
        },
      },
      {
        id: 'mcp-integrations',
        kind: 'surface',
        title: 'Find MCP integrations in the catalog',
        body: 'The integrations catalog lists all pre-built specs. MCP integrations show "mcp" as their transport type. Open the catalog and filter by type to see what is available and inspect the tool_name and argument shapes.',
        action: { label: 'Open Integrations Catalog', href: '/integrations', autoCompletes: true },
      },
      {
        id: 'mcp-terminal',
        kind: 'command',
        title: 'Inspect extract transport options',
        body: 'Run extract --help to see all transport flags, including the --mcp-server-url and --mcp-bearer-token options used for SSE transports.',
        command: command('extract', ['--help']),
        action: terminalAction('Open Extract Help', command('extract', ['--help'])),
      },
    ],
  },
  UNIFIED_INGEST_MODULE,
  {
    id: 'advanced-extract-load',
    title: 'Advanced Extract and Load',
    group: 'advanced-elt',
    description:
      'Practice incremental extraction, destination choices, and pipeline export handoff.',
    outcome:
      'You can reason about cursor state, load strategy, schema evolution, and local pipeline runs.',
    estimatedMinutes: 55,
    cliPhaseIds: ['extract-pagination', 'load-strategies', 'pipeline-runner'],
    credentialEnvVars: ['GITHUB_TOKEN', 'STRIPE_API_KEY', 'HUBSPOT_ACCESS_TOKEN'],
    steps: [
      {
        id: 'incremental-concept',
        kind: 'concept',
        title: 'Incremental sync and cursor state',
        body: 'On the first run, Bobsled Core does a full extraction and writes a STATE message containing the cursor — typically a timestamp or max ID. On subsequent runs, the extractor reads the stored state and fetches only records newer than the cursor. This means API calls and load volume shrink dramatically after the initial sync.',
      },
      {
        id: 'load-strategies',
        kind: 'concept',
        title: 'Load strategies: append, merge, full_refresh',
        body: 'append adds every record as a new row — useful for event logs. merge upserts on a primary key, updating existing rows and inserting new ones. full_refresh truncates and reloads the table on every run. Choose based on whether your source data mutates: events use append, CRM records use merge, small reference tables use full_refresh.',
      },
      {
        id: 'pipeline-builder',
        kind: 'surface',
        title: 'Build a pipeline in Explorer',
        body: 'The pipeline builder walks you through preset → integrations → resources → destination → schedule → review. At the review step you can inspect the generated bobsled.yml before exporting or deploying. Use DuckDB as the destination to run locally without cloud credentials.',
        action: { label: 'Open Pipeline Builder', href: '/pipelines/new', autoCompletes: true },
      },
      {
        id: 'schema-evolution',
        kind: 'concept',
        title: 'Schema evolution',
        body: 'When a source API adds a new field, the extractor emits an updated SCHEMA message before the first RECORD that contains the new column. The loader detects the schema diff and ALTER TABLEs the destination automatically. Columns are never dropped automatically — removal requires an explicit migration or a full_refresh.',
      },
      {
        id: 'credential-check',
        kind: 'check',
        title: 'Check common API credentials',
        body: 'With GITHUB_TOKEN, STRIPE_API_KEY, or HUBSPOT_ACCESS_TOKEN set you can run a real incremental extraction. Without them the pipeline builder still generates valid YAML you can inspect and export.',
        action: {
          label: 'Check API Credentials',
          href: '/api/learn/credentials?module=advanced-extract-load',
          autoCompletes: true,
        },
      },
      {
        id: 'extract-command',
        kind: 'command',
        title: 'Run an extraction',
        body: 'The core ELT command is `bobsled extract <integration>`. It reads the integration YAML, authenticates using your configured credentials, and streams SCHEMA, RECORD, and STATE messages to stdout. Pipe it into `bobsled load` to land data: `bobsled extract github | bobsled load --destination duckdb --strategy merge --primary-key id`. The `--resource` flag limits extraction to a single resource; omitting it runs all resources defined in the spec.',
        command: command('extract', ['--help']),
        action: terminalAction('Open Extract Command', command('extract', ['--help'])),
      },
      {
        id: 'load-help',
        kind: 'command',
        title: 'Inspect loader destination options',
        body: 'Run load --help to see all destination flags: --destination duckdb|bigquery|gcs|local, --strategy append|merge|full_refresh, and --primary-key. These map directly to the destination block in bobsled.yml.',
        command: command('load', ['--help']),
        action: terminalAction('Open Load Help', command('load', ['--help'])),
      },
    ],
  },
  {
    id: 'warehouses',
    title: 'Warehouse Sources and Destinations',
    group: 'warehouses',
    description:
      'Understand source extraction from warehouses and load targets for analytical systems.',
    outcome:
      'You can distinguish warehouse source configs, destination configs, and dialect-specific modeling.',
    estimatedMinutes: 40,
    cliPhaseIds: ['warehouse-sources', 'warehouse-destinations', 'dialects'],
    credentialEnvVars: ['SNOWFLAKE_ACCOUNT', 'POSTGRES_URL', 'BIGQUERY_PROJECT_ID'],
    steps: [
      {
        id: 'warehouse-source',
        kind: 'concept',
        title: 'Warehouse sources as extractor resources',
        body: 'A warehouse source uses a connection block (host, port, database, credentials) and a source block that lists tables or queries to replicate. The extractor reads from the warehouse and emits the same SCHEMA/RECORD/STATE protocol as any REST extraction — the loader does not know or care what produced the stream.',
      },
      {
        id: 'warehouse-source-yaml',
        kind: 'spec',
        title: 'Replication block structure',
        body: 'The replication block in a warehouse source YAML controls which tables are extracted and how. `table` selects the source table; `primary_key` enables merge loads at the destination; `replication_method` is FULL_TABLE or INCREMENTAL; `replication_key` names the cursor column used to fetch only new or changed rows. Warehouse sources support the same append, merge, and full_refresh load strategies as REST sources.',
        sql: 'replication:\n  - table: public.orders\n    primary_key: id\n    replication_method: INCREMENTAL\n    replication_key: updated_at',
      },
      {
        id: 'warehouse-destinations',
        kind: 'concept',
        title: 'Warehouse destinations: BigQuery and Snowflake',
        body: 'When loading into BigQuery, Bobsled Core writes to a dataset and table using the Google Cloud Storage staging path for large loads. For Snowflake it uses the Snowflake COPY INTO pattern with an internal stage. Both destinations respect the load strategy — append appends, merge upserts, full_refresh recreates the table.',
      },
      {
        id: 'destination-catalog',
        kind: 'surface',
        title: 'Inspect destination choices in the builder',
        body: 'The pipeline builder destination step lists all supported targets with their required credential fields. Open it to see how DuckDB, BigQuery, ClickHouse, Turbopuffer, GCS, and local destinations differ in their configuration blocks.',
        action: {
          label: 'Open Destination Step',
          href: '/pipelines/new?step=destination',
          autoCompletes: true,
        },
      },
      {
        id: 'model-dialects',
        kind: 'concept',
        title: 'Dialect-specific model compilation',
        body: 'Model Spec compiles model YAML to SQL for the target dialect. BigQuery uses MERGE INTO with backtick identifiers. Snowflake uses MERGE with double-quoted identifiers and VARIANT for JSON columns. DuckDB uses the same MERGE syntax as Snowflake but with PostgreSQL-style types. The model spec is dialect-agnostic — dialect selection happens at compile time.',
      },
      {
        id: 'model-compile',
        kind: 'command',
        title: 'Compile a model for a target dialect',
        body: 'Run model --help to see the --dialect flag and output options. You can compile the same model spec to BigQuery, Snowflake, or DuckDB SQL without changing the YAML.',
        command: command('model', ['--help']),
        action: terminalAction('Open Model Help', command('model', ['--help'])),
      },
    ],
  },
];
