/**
 * Dogsled Core -> Bobsled Core rename mapping (step 4, reviewed name map).
 *
 * Source: the step-3 name map (78 rules, measured on dogsled-core 0eff6e6),
 * updated with the 12 Nov decisions: npm @bobsled-inc/bobsled-core, CLI
 * `bobsled`, settings BOBSLED_CORE_*, skills `bobsled-*`, the "Dogsled Cloud"
 * guide becomes a neutral "Hosted runs" page, Track ids become bobsled_*, and
 * no optional compatibility aliases.
 *
 * Rule shape: id, category (BC-01..BC-22, see name-map.md), kind
 * ('path' | 'content'), match (string | RegExp), replace, include?, exclude?
 * (globs), profiles? ('toolkit' | 'app'), note?.
 * Rules run in order, most specific first; later rules see rewritten text.
 * Every rule matches only old spellings, so applying all rules twice changes
 * nothing the second time (tests/unit/rename-mapping.test.mjs checks this).
 *
 * "design" in a note means the rule only renames the spelling; a design PR
 * adds the reader that still accepts stored old names.
 */

const NOT_HISTORY = ['CHANGELOG.md', 'docs/solutions/**'];

// Files the rename never touches: this tool, the old-name guard and their
// tests necessarily spell the old names.
export const SELF_PATHS = [
  'scripts/rename/**',
  'tests/unit/rename-mapping.test.mjs',
  'scripts/guards/old-names.mjs',
  'scripts/guards/old-names-allow.json',
  'scripts/guards/old-names-baseline.json',
  'tests/unit/guard-old-names.test.mjs',
];

// Preview tooling runs in dogsled-core until the export, so its repository
// check must keep the current repository name.
const PREVIEW_TOOLING = [
  '.github/workflows/preview-publish.yml',
  'scripts/release/preview.mjs',
  'tests/unit/release-preview.test.mjs',
];

// ─── Keep list ────────────────────────────────────────────────────────────────
// Entries that contain "dogsled" are masked before any rule runs, so no rule
// can rewrite them. `paths` limits an entry to some files; `profiles: ['app']`
// marks names that only occur in Blueprints and app code, never in Core.

export const KEEP_LIST = [
  { pattern: '@bobsled-inc', note: 'npm scope and GitHub org' },
  { pattern: 'bobsled-inc/', note: 'GitHub org path' },
  {
    pattern: 'bobsled_api',
    note: 'Bobsled data-sharing integration id (also in _source_bobsled_api schemas)',
  },
  {
    pattern: 'bobsled-api',
    note: 'integration value; bobsled-api-* skill names stay reserved for it',
  },
  { pattern: 'BOBSLED_API_HOST', note: 'bobsled_api integration secret' },
  { pattern: 'BOBSLED_API_KEY', note: 'bobsled_api integration secret' },
  { pattern: 'BOBSLED_CLIENT_ID', note: 'bobsled_api integration secret' },
  { pattern: 'BOBSLED_SERVICE_ACCOUNT_EMAIL', note: 'bobsled_api integration secret' },
  { pattern: 'BOBSLED_SERVICE_ACCOUNT_SECRET', note: 'bobsled_api integration secret' },
  {
    pattern: 'bobsled_managed_snowflake',
    note: 'bobsled_api integration value; must not be read as a managed destination type',
  },
  { pattern: 'bobsled.com', note: 'company domain (docs.bobsled.com, api.bobsled.com)' },
  { pattern: 'Bobsled, Inc.', note: 'legal entity (LICENSE/NOTICE)' },
  {
    pattern: 'Dogsled Cloud',
    note: 'the hosted app keeps the Dogsled brand (D7); the Hosted runs page names it once (editorial pass in step 5)',
  },
  { pattern: 'dogsled.it', note: 'app domain (D7)' },
  { pattern: 'dogsled\\.it', note: 'escaped app domain in the privacy guard and its tests (D7)' },
  {
    pattern: 'dogsledai.com',
    paths: [
      'scripts/security/**',
      'scripts/guards/privacy*',
      'tests/unit/security-runtime-policy.test.mjs',
      'tests/unit/guard-privacy.test.mjs',
    ],
    note: 'app domain blocked by the runtime policy and privacy guard (D7); contact emails are renamed by BC-17',
  },
  {
    pattern: '@dogsled/',
    note: 'Dogsled app workspace scope (e.g. @dogsled/lakehouse-execution) named in comments (D7)',
  },
  {
    pattern: 'dogsled\\.(?:co|ai|cloud|com|it)',
    paths: ['scripts/security/policy.mjs'],
    note: 'Dogsled-operated hosts stay blocked by the runtime network policy (D7)',
  },
  { pattern: '_DOGSLED_LIVE', note: 'app-owned live database name (D7), not a Core name' },
  {
    pattern: 'dogsled-logo.png',
    note: 'Explorer logo: the Explorer PR replaces it with a text-only "Bobsled Core" wordmark (step-3 answer)',
  },
  {
    pattern: "'bobsled-inc/dogsled-core'",
    paths: PREVIEW_TOOLING,
    note: 'preview publishing runs in dogsled-core until the export',
  },
  {
    pattern: 'dogsled_write',
    profiles: ['app'],
    note: 'customer Snowflake object; app profile only',
  },
  { pattern: 'dogsled_write_db', profiles: ['app'], note: 'customer object; app profile only' },
  { pattern: 'dogsled_role', profiles: ['app'], note: 'customer object; app profile only' },
  { pattern: 'dogsled_wh_auto', profiles: ['app'], note: 'customer object; app profile only' },
  { pattern: 'dogsled_properties', profiles: ['app'], note: 'customer object; app profile only' },
  { pattern: 'dogsled_models', profiles: ['app'], note: 'customer object; app profile only' },
  { pattern: '.dogsled schema', profiles: ['app'], note: 'customer schema; app profile only' },
  {
    pattern: 'dogsled_test',
    profiles: ['app'],
    note: 'main test fixture objects; app profile only (Core fixtures are renamed)',
  },
  { pattern: 'bobsled-dogsled', note: 'Vercel team/project slug' },
  {
    pattern: 'dogsled_canonical_gtm',
    profiles: ['app'],
    note: 'product fixture; app profile only',
  },
];

// ─── Handled by design PRs (rules rename spelling only) ──────────────────────

export const HANDLED_BY_DESIGN = [
  {
    item: 'Blueprint keys dogsled_connection_ref / dogsled_source_kind / type dogsled_managed',
    note: 'both spellings accepted with no warning until Dash has switched; alias table inverted; conflict rule kept (BC-11)',
  },
  {
    item: 'Config file dogsled.yml / .yaml and local folder .dogsled/',
    note: 'renamed to bobsled.yml and .bobsled/; no optional alias (step-3 answer); no deployed root dogsled.yml exists (BC-07, BC-09)',
  },
  {
    item: 'Saved formats',
    note: 'readers accept track.*, dogsled.* and bobsled.*; writers emit bobsled.* (BC-12)',
  },
  {
    item: 'Warehouse names',
    note: 'rename only: automatic in-place adoption of _dogsled_* / __dogsled_* (BC-13, BC-14)',
  },
  {
    item: 'OSI vendor tag',
    note: 'BOBSLED native; DOGSLED read natively; TRACK stays foreign + warning (BC-10)',
  },
  {
    item: 'Agentic run identity',
    note: 'normalise _dogsled_ -> _bobsled_ before comparing saved definitions, or in-flight runs fail with definition_changed (BC-13)',
  },
  {
    item: 'Managed destination type',
    note: 'exact list {bobsled_managed, dogsled_managed}, not a prefix, to skip bobsled_managed_snowflake (BC-11)',
  },
  {
    item: 'Old DOGSLED_* settings',
    note: 'no fallback; warn when an old Core setting is set without its BOBSLED_CORE_* twin (BC-08)',
  },
  {
    item: 'Public code names, bin and skill names',
    note: 'no Dogsled* re-exports, no dogsled bin, no old skill names (step-3 answer)',
  },
  {
    item: 'Explorer logo',
    note: 'text-only "Bobsled Core" wordmark; dogsled-logo.png is kept by the script and removed by hand',
  },
  {
    item: 'Old-name guard',
    note: 'scripts/guards/old-names.mjs; report-only until the end of step 5',
  },
  {
    item: 'CHANGELOG.md',
    note: 'restart at Bobsled Core 0.1.0 in the export; history not rewritten',
  },
];

export const SPECIAL_ATTENTION = [
  {
    id: 'match-key-secret',
    summary:
      'DOGSLED_MATCH_KEY_SECRET -> BOBSLED_CORE_MATCH_KEY_SECRET: carry the VALUE over unchanged (HMAC match keys, stable entity ids).',
  },
  {
    id: 'runtime-secret-placeholder',
    summary:
      '__DOGSLED_RUNTIME_SECRET_DOGSLED_MATCH_KEY_SECRET__ is a compiled-SQL placeholder. Substitution must accept both spellings in case compiled SQL is stored by a host.',
  },
  {
    id: 'agentic-identity',
    summary:
      'Agentic run definitions are digested (run.ts identity/comparable). Output columns include _dogsled_* metadata, so a resumed run after the rename trips definition_changed unless the comparison normalises names.',
  },
  {
    id: 'bq-ownership-label',
    summary:
      'dogsled_temp_dataset (BigQuery label, Databricks TBLPROPERTY) proves Core owns a temp dataset/table. Readers must accept both labels or Core stops cleaning old ones.',
  },
  {
    id: 'es-replace-key',
    summary:
      'Elasticsearch dogsled_replace_key is a stored document field; mappings cannot be renamed in place. Keep using the old field on indexes that have it.',
  },
  {
    id: 'source-bobsled-api',
    summary:
      'Source schemas such as _source_bobsled_api contain "_bobsled_". Takeover and guard patterns must anchor on the exact Core prefixes, never on a bare _bobsled_ substring.',
  },
  {
    id: 'pnpm-lock',
    summary: 'pnpm-lock.yaml is skipped. Run pnpm install after the package/folder rename.',
  },
  {
    id: 'generated-files',
    summary:
      'packages/integrations/src/*/generated-data.ts and packages/skills/src/generated-data.ts are generated; rename the sources and regenerate.',
  },
];

// ─── Rules ───────────────────────────────────────────────────────────────────

export const RULES = [
  // BC-01 package, folder, bin
  {
    id: 'pkg-preview-name',
    category: 'BC-01',
    kind: 'content',
    match: '@bobsled-inc/dogsled-preview',
    replace: '@bobsled-inc/bobsled-core-preview',
    note: 'Preview package (D5b).',
  },
  {
    id: 'pkg-skills-subpath',
    category: 'BC-01',
    kind: 'content',
    match: /@bobsled-inc\/skills\/dogsled\b/g,
    replace: '@bobsled-inc/skills/bobsled',
  },
  {
    id: 'pkg-scoped-name',
    category: 'BC-01',
    kind: 'content',
    match: /@bobsled-inc\/dogsled(?![\w-])/g,
    replace: '@bobsled-inc/bobsled-core',
    note: 'Main npm package.',
  },
  {
    id: 'pkg-dir-content-ref',
    category: 'BC-01',
    kind: 'content',
    match: /\bpackages\/dogsled\b/g,
    replace: 'packages/bobsled-core',
  },
  {
    id: 'pkg-dir-segments',
    category: 'BC-01',
    kind: 'content',
    match: /(['"])packages\1,\s*(['"])dogsled\2/g,
    replace: "'packages', 'bobsled-core'",
    note: 'path.join segments (explorer dogsled-cli.ts, runtime/workspace.ts).',
  },
  {
    id: 'pkg-root-name',
    category: 'BC-01',
    kind: 'content',
    match: '"name": "dogsled"',
    replace: '"name": "bobsled-core"',
    include: ['package.json'],
  },
  {
    id: 'pkg-bin',
    category: 'BC-01',
    kind: 'content',
    match: '"dogsled": "./bin/cli.mjs"',
    replace: '"bobsled": "./bin/cli.mjs"',
    include: ['packages/dogsled/package.json'],
  },
  {
    id: 'pkg-skills-entry',
    category: 'BC-01',
    kind: 'content',
    match: "dogsled: 'src/dogsled.ts'",
    replace: "bobsled: 'src/bobsled.ts'",
    include: ['packages/skills/tsup.config.ts'],
  },
  {
    id: 'pkg-skills-export',
    category: 'BC-01',
    kind: 'content',
    match: /\.\/(dist\/)?dogsled(\.d\.ts|\.js)?"/g,
    replace: './$1bobsled$2"',
    include: ['packages/skills/package.json'],
  },
  {
    id: 'ci-leg-name',
    category: 'BC-01',
    kind: 'content',
    match: 'leg: [model, graph, dogsled, rest]',
    replace: 'leg: [model, graph, bobsled-core, rest]',
    include: ['.github/workflows/*.yml'],
  },
  {
    id: 'path-pkg-dir',
    category: 'BC-01',
    kind: 'path',
    match: 'packages/dogsled',
    replace: 'packages/bobsled-core',
  },
  {
    id: 'path-skills-entry',
    category: 'BC-01',
    kind: 'path',
    match: 'packages/skills/src/dogsled.ts',
    replace: 'packages/skills/src/bobsled.ts',
  },

  // BC-02 repo metadata and URLs
  {
    id: 'repo-url',
    category: 'BC-02',
    kind: 'content',
    match: /github\.com\/bobsled-inc\/dogsled-core\b/g,
    replace: 'github.com/bobsled-inc/bobsled-core',
  },
  {
    id: 'repo-slug',
    category: 'BC-02',
    kind: 'content',
    match: /\bbobsled-inc\/dogsled-core\b/g,
    replace: 'bobsled-inc/bobsled-core',
    note: 'Workflow repository guards, API paths.',
  },
  {
    id: 'repo-team',
    category: 'BC-17',
    kind: 'content',
    match: /@bobsled-inc\/dogsled-maintainers\b/g,
    replace: '@bobsled-inc/bobsled-core-maintainers',
  },
  {
    id: 'pkg-keyword',
    category: 'BC-02',
    kind: 'content',
    match: '"dogsled",',
    replace: '"bobsled",',
    include: ['package.json', '**/package.json'],
  },

  // BC-17 contacts (addresses TBD, D8)
  {
    id: 'email-security',
    category: 'BC-17',
    kind: 'content',
    match: 'security@dogsledai.com',
    replace: 'security@bobsled.co',
    note: 'TBD exact address (D8).',
  },
  {
    id: 'email-maintainers',
    category: 'BC-17',
    kind: 'content',
    match: 'maintainers@dogsledai.com',
    replace: 'maintainers@bobsled.co',
    note: 'TBD exact address (D8).',
  },

  // BC-03 release constants
  {
    id: 'release-pkg-const',
    category: 'BC-03',
    kind: 'content',
    match: /\bDOGSLED_PACKAGE_NAME\b/g,
    replace: 'BOBSLED_CORE_PACKAGE_NAME',
  },
  {
    id: 'husky-product-key',
    category: 'BC-18',
    kind: 'content',
    match: 'product: "dogsled-core"',
    replace: 'product: "bobsled-core"',
    include: ['.github/workflows/*.yml'],
    note: 'Husky registry key changes in the app at the same time.',
  },
  {
    id: 'contribution-marker',
    category: 'BC-18',
    kind: 'content',
    match: '<!-- dogsled-contribution-policy -->',
    replace: '<!-- bobsled-core-contribution-policy -->',
  },

  // BC-08 specials (before the broad env rule)
  {
    id: 'env-runtime-secret-token',
    category: 'BC-08',
    kind: 'content',
    match: '__DOGSLED_RUNTIME_SECRET_DOGSLED_MATCH_KEY_SECRET__',
    replace: '__BOBSLED_CORE_RUNTIME_SECRET_BOBSLED_CORE_MATCH_KEY_SECRET__',
    note: 'design: accept both placeholders.',
  },
  {
    id: 'example-object-names',
    category: 'BC-21',
    kind: 'content',
    match:
      /\bDOGSLED_(RAW|MULTI_CONN_DB(?:_OVERRIDE)?|MULTI_CONN_WH|MULTI_CONN_ROLE|AI_WH|LOADER)\b(?!_)/g,
    replace: 'BOBSLED_$1',
    note: 'Example warehouse object names in docs/examples, not settings.',
  },

  // BC-14 / BC-13 warehouse names (same length: dogsled and bobsled are both 7 letters)
  {
    id: 'wh-prefix-lower',
    category: 'BC-14',
    kind: 'content',
    match: /(_{1,2})dogsled_/g,
    replace: '$1bobsled_',
    note: 'All _dogsled_* and __dogsled_* names (loaded_at, run_id, evidence, confidence, reason, agentic tables, cp/pub/stg/uq/win/cursor/new/old/live/source/models/custom/xwh_locks). design: takeover.',
  },
  {
    id: 'wh-prefix-upper',
    category: 'BC-14',
    kind: 'content',
    match: /(_{1,2})DOGSLED_/g,
    replace: '$1BOBSLED_',
    note: 'Snowflake uppercase forms.',
  },
  {
    id: 'wh-prefix-check',
    category: 'BC-14',
    kind: 'content',
    match: "startsWith('_dogsled_')",
    replace: "startsWith('_bobsled_')",
    note: 'Already covered by wh-prefix-lower; listed so design PR adds both prefixes to the reserved check.',
  },

  // BC-15 labels, properties, fields, user agent
  {
    id: 'wh-temp-dataset-label',
    category: 'BC-15',
    kind: 'content',
    match: /\bdogsled_temp_dataset\b/g,
    replace: 'bobsled_temp_dataset',
    note: 'design: accept both on read.',
  },
  {
    id: 'bq-labels',
    category: 'BC-15',
    kind: 'content',
    match: /\bdogsled_(stream|strategy)\b/g,
    replace: 'bobsled_$1',
  },
  {
    id: 'es-replace-key',
    category: 'BC-15',
    kind: 'content',
    match: /\bdogsled_replace_key\b/g,
    replace: 'bobsled_replace_key',
    note: 'design: keep old field on existing indexes.',
  },
  {
    id: 'ua-extractor',
    category: 'BC-15',
    kind: 'content',
    match: /\bdogsled-extractor\b/g,
    replace: 'bobsled-core-extractor',
  },

  // BC-11 Blueprint keys and types (both accepted)
  {
    id: 'yaml-connection-ref',
    category: 'BC-11',
    kind: 'content',
    match: /\bdogsled_connection_ref\b/g,
    replace: 'bobsled_connection_ref',
  },
  {
    id: 'yaml-source-kind',
    category: 'BC-11',
    kind: 'content',
    match: /\bdogsled_source_kind\b/g,
    replace: 'bobsled_source_kind',
  },
  {
    id: 'yaml-managed',
    category: 'BC-11',
    kind: 'content',
    match: /\bdogsled_managed\b/g,
    replace: 'bobsled_managed',
  },
  {
    id: 'yaml-managed-future',
    category: 'BC-11',
    kind: 'content',
    match: /\bdogsled_(destination_kind|snowflake_warehouse|databricks_workspace)\b/g,
    replace: 'bobsled_$1',
  },
  {
    id: 'managed-prefix-const',
    category: 'BC-11',
    kind: 'content',
    match: "DOGSLED_MANAGED_TYPE_PREFIX = 'dogsled_'",
    replace: "BOBSLED_CORE_MANAGED_TYPE_PREFIX = 'bobsled_'",
    note: 'design: accept dogsled_ and bobsled_ managed types.',
  },

  // BC-12 saved formats
  {
    id: 'manifest-kind',
    category: 'BC-12',
    kind: 'content',
    match: /\bdogsled\.pipeline\.dag\b/g,
    replace: 'bobsled.pipeline.dag',
    note: 'design: reader accepts track./dogsled./bobsled.',
  },
  {
    id: 'manifest-cli-version',
    category: 'BC-12',
    kind: 'content',
    match: /\bdogsled_cli_version\b/g,
    replace: 'bobsled_cli_version',
    note: 'design: reader accepts all three.',
  },
  {
    id: 'run-kind',
    category: 'BC-12',
    kind: 'content',
    match: /\bdogsled\.model\.run\b/g,
    replace: 'bobsled.model.run',
    note: 'design: reader accepts track./dogsled./bobsled.',
  },
  {
    id: 'manifest-default-command',
    category: 'BC-12',
    kind: 'content',
    match: /default_command: (z\.literal\()?'dogsled'/g,
    replace: "default_command: $1'bobsled'",
    note: 'design: reader accepts dogsled and bobsled.',
  },

  // BC-22 leftover Track ids (step-3 answer: rename now; the app updates its own default in the switch)
  {
    id: 'track-graph-id',
    category: 'BC-22',
    kind: 'content',
    match: /`track_\$\{slugForPipelineName\(/g,
    replace: '`bobsled_${slugForPipelineName(',
    note: 'Pipeline graph id track_<pipeline> -> bobsled_<pipeline>.',
  },
  {
    id: 'track-graph-id-fixtures',
    category: 'BC-22',
    kind: 'content',
    match: /\b(graph_?[iI]d(?::|\s*=)\s*[`'"])track_/g,
    replace: '$1bobsled_',
    note: 'Graph ids in manifest tests.',
  },
  {
    id: 'track-export-name',
    category: 'BC-22',
    kind: 'content',
    match: /(['"])track_export\1/g,
    replace: '$1bobsled_export$1',
    note: 'Default OSI semantic model name.',
  },
  {
    id: 'track-smoke-and-checkpoints',
    category: 'BC-22',
    kind: 'content',
    match: /\btrack_(xwh_smoke_|checkpoints\b)/g,
    replace: 'bobsled_$1',
    note: 'Smoke dataset prefix and example checkpoint schema.',
  },

  // BC-10 URIs, vendor tag, headers
  {
    id: 'uri-protocol',
    category: 'BC-10',
    kind: 'content',
    match: /\bdogsled:\/\//g,
    replace: 'bobsled://',
    note: 'design: accept dogsled:// in model files and OSI documents.',
  },
  {
    id: 'osi-vendor-tag',
    category: 'BC-10',
    kind: 'content',
    match: /(['"])DOGSLED\1/g,
    replace: "'BOBSLED'",
    include: ['packages/model-spec/**'],
    note: 'design: DOGSLED read natively, TRACK stays foreign.',
  },
  {
    id: 'osi-vendor-yaml',
    category: 'BC-10',
    kind: 'content',
    match: /vendor_name: DOGSLED\b/g,
    replace: 'vendor_name: BOBSLED',
  },
  {
    id: 'explorer-header',
    category: 'BC-16',
    kind: 'content',
    match: /\bdogsled-explorer-token\b/g,
    replace: 'bobsled-explorer-token',
  },

  // BC-07 config files
  {
    id: 'config-yml',
    category: 'BC-07',
    kind: 'content',
    match: /\bdogsled\.yml\b/g,
    replace: 'bobsled.yml',
  },
  {
    id: 'config-yaml',
    category: 'BC-07',
    kind: 'content',
    match: /\bdogsled\.yaml\b/g,
    replace: 'bobsled.yaml',
  },
  {
    id: 'config-setup-answers',
    category: 'BC-07',
    kind: 'content',
    match: /\bdogsled\.setup\.(answers\.yml|summary\.md)\b/g,
    replace: 'bobsled.setup.$1',
  },
  {
    id: 'path-config-yml',
    category: 'BC-07',
    kind: 'path',
    match: /(^|\/)dogsled\.(ya?ml(?:\.txt)?)$/,
    replace: '$1bobsled.$2',
  },

  // BC-09 local folders and files
  {
    id: 'dir-dot',
    category: 'BC-09',
    kind: 'content',
    match: /\.dogsled\//g,
    replace: '.bobsled/',
  },
  {
    id: 'dir-dot-bare',
    category: 'BC-09',
    kind: 'content',
    match: /(['"`])\.dogsled\1/g,
    replace: '$1.bobsled$1',
  },
  {
    id: 'local-duckdb',
    category: 'BC-09',
    kind: 'content',
    match: /\bdogsled\.duckdb\b/g,
    replace: 'bobsled.duckdb',
  },
  {
    id: 'path-dot-dir',
    category: 'BC-09',
    kind: 'path',
    match: /(^|\/)\.dogsled(?=\/|$)/,
    replace: '$1.bobsled',
  },

  // BC-16 skills, plugin, MCP, Explorer
  {
    id: 'plugin-dir',
    category: 'BC-16',
    kind: 'path',
    match: 'plugins/dogsled-core',
    replace: 'plugins/bobsled-core',
  },
  {
    id: 'plugin-name',
    category: 'BC-16',
    kind: 'content',
    match: /\bdogsled-core\b/g,
    replace: 'bobsled-core',
    note: 'Plugin name, Husky product id, prose references to the repo.',
  },
  {
    id: 'cowork-plugin',
    category: 'BC-16',
    kind: 'content',
    match: /\bdogsled-setup-plugin\b/g,
    replace: 'bobsled-setup-plugin',
  },
  {
    id: 'mcp-server-name',
    category: 'BC-16',
    kind: 'content',
    match: "serverInfo: { name: 'dogsled' }",
    replace: "serverInfo: { name: 'bobsled' }",
  },
  {
    id: 'explorer-title',
    category: 'BC-16',
    kind: 'content',
    match: /\bDogsled Explorer\b/g,
    replace: 'Bobsled Core Explorer',
  },
  {
    id: 'guide-hosted-runs',
    category: 'BC-16',
    kind: 'content',
    match: /\bdogsled-cloud\.md\b/g,
    replace: 'hosted-runs.md',
    note: 'Step-3 answer: neutral "Hosted runs" page that names the Dogsled app once (editorial pass by hand).',
  },
  {
    id: 'path-guide-hosted-runs',
    category: 'BC-16',
    kind: 'path',
    match: 'docs/guides/dogsled-cloud.md',
    replace: 'docs/guides/hosted-runs.md',
  },
  {
    id: 'skill-and-hyphen-names',
    category: 'BC-16',
    kind: 'content',
    match: /(?<![\w@-])dogsled-([a-z0-9][a-z0-9-]*)/g,
    replace: 'bobsled-$1',
    note: 'Skills (dogsled-init ...), doctor checks (dogsled-config), MCP (dogsled-ontology), CSS (dogsled-gradient-brand), file names.',
  },
  {
    id: 'path-hyphen-names',
    category: 'BC-16',
    kind: 'path',
    match: /(^|\/)dogsled-([^/]*)/g,
    replace: '$1bobsled-$2',
    note: 'Skill folders (bobsled-init ...), cowork kit, plugin and file names.',
  },
  {
    id: 'path-solutions-suffix',
    category: 'BC-17',
    kind: 'path',
    match: /-dogsled-(\d{8}\.md)$/,
    replace: '-bobsled-$1',
  },

  // BC-20 error and warning codes (explicit; the broad env rule would do the same)
  {
    id: 'code-legacy-key',
    category: 'BC-20',
    kind: 'content',
    match: /\bDOGSLED_LEGACY_BLUEPRINT_KEY\b/g,
    replace: 'BOBSLED_CORE_LEGACY_BLUEPRINT_KEY',
    note: 'design: no warning for dogsled_* keys until Dash has switched its generator (step-3 answer).',
  },
  {
    id: 'code-cache-deprecated',
    category: 'BC-20',
    kind: 'content',
    match: /\bDOGSLED_SOURCE_MODE_CACHE_DEPRECATED\b/g,
    replace: 'BOBSLED_CORE_SOURCE_MODE_CACHE_DEPRECATED',
  },
  {
    id: 'code-invalid-extension',
    category: 'BC-20',
    kind: 'content',
    match: /\binvalid_dogsled_extension\b/g,
    replace: 'invalid_bobsled_extension',
  },
  {
    id: 'code-runtime-kinds',
    category: 'BC-20',
    kind: 'content',
    match: /\bDOGSLED_RUNTIME_ERROR_(KINDS|KIND_SET|PUBLIC_MESSAGES)\b/g,
    replace: 'BOBSLED_CORE_RUNTIME_ERROR_$1',
  },

  // BC-05 identifiers
  {
    id: 'identifier-pascal',
    category: 'BC-05',
    kind: 'content',
    match: /\bDogsled([A-Z]\w*)/g,
    replace: 'Bobsled$1',
    note: 'DogsledConfig -> BobsledConfig, DogsledRuntimeError -> BobsledRuntimeError, ...',
  },
  {
    id: 'identifier-camel-inner',
    category: 'BC-05',
    kind: 'content',
    match: /([A-Za-z0-9])Dogsled(?=[A-Z_\b]|\b)/g,
    replace: '$1Bobsled',
    note: 'openDogsledProject -> openBobsledProject, ExplorerDogsledCommand -> ExplorerBobsledCommand.',
  },
  {
    id: 'identifier-camel-split',
    category: 'BC-05',
    kind: 'content',
    match: /\bdogSled([A-Z]\w*)/g,
    replace: 'bobsled$1',
    note: 'dogSledModelIds -> bobsledModelIds.',
  },
  {
    id: 'identifier-case-variant',
    category: 'BC-05',
    kind: 'content',
    match: /\bDogsled_Managed\b/g,
    replace: 'Bobsled_Managed',
    note: 'Case-variant fixture of the managed type.',
  },
  {
    id: 'identifier-camel-lead',
    category: 'BC-05',
    kind: 'content',
    match: /\bdogsled([A-Z]\w*)/g,
    replace: 'bobsled$1',
    note: 'dogsledVersion -> bobsledVersion.',
  },
  {
    id: 'eslint-plugin-ns',
    category: 'BC-19',
    kind: 'content',
    match: /(['"])dogsled\//g,
    replace: '$1bobsled/',
    include: ['eslint.config.base.mjs', 'eslint.config.mjs', '**/eslint.config.mjs', '**/*.ts'],
  },

  // BC-08 broad env and constant prefix (after specials; leading-underscore names are not hit)
  {
    id: 'env-prefix',
    category: 'BC-08',
    kind: 'content',
    match: /(?:\b|(?<=\\n))DOGSLED_(?=[A-Z0-9<])/g,
    replace: 'BOBSLED_CORE_',
    note: 'All remaining DOGSLED_* settings and constants (D2), also after an escaped newline and in DOGSLED_<OFFERING>_* placeholders.',
  },

  // BC-12/BC-14 leftovers in lowercase snake case (fixtures, examples)
  {
    id: 'snake-leftovers',
    category: 'BC-21',
    kind: 'content',
    match: /(?:\b|(?<=\\n))dogsled_([a-z0-9][a-z0-9_]*)/g,
    replace: 'bobsled_$1',
    exclude: [],
    note: 'dogsled_workspace, dogsled_multi_conn_*, dogsled_slot, dogsled_pub, dogsled_internal_id, dogsled_test in Core fixtures.',
  },

  {
    id: 'snake-bare-prefix',
    category: 'BC-11',
    kind: 'content',
    match: /\bdogsled_(?![a-z0-9])/g,
    replace: 'bobsled_',
    note: "Bare 'dogsled_' prefix strings (managed type, x-key stripping). design: accept both.",
  },
  {
    id: 'mid-hyphen',
    category: 'BC-21',
    kind: 'content',
    match: /(?<=[a-z0-9]-)dogsled(?=[-.])/g,
    replace: 'bobsled',
    exclude: NOT_HISTORY,
    note: 'my-dogsled-project, run-dogsled.sh, install-dogsled examples.',
  },
  {
    id: 'dot-hyphen-dir',
    category: 'BC-09',
    kind: 'content',
    match: /\.dogsled-/g,
    replace: '.bobsled-',
  },
  {
    id: 'plugin-marketplace',
    category: 'BC-16',
    kind: 'content',
    match: /bobsled-core@dogsled\b/g,
    replace: 'bobsled-core@bobsled',
    note: 'Plugin marketplace id.',
  },

  // BC-10 remaining uppercase word
  {
    id: 'upper-word',
    category: 'BC-10',
    kind: 'content',
    match: /\bDOGSLED\b/g,
    replace: 'BOBSLED',
  },

  // BC-06 prose
  {
    id: 'docs-install-anchor',
    category: 'BC-06',
    kind: 'content',
    match: /#install-dogsled\b/g,
    replace: '#install-bobsled-core',
    note: 'Heading "Install Dogsled" becomes "Install Bobsled Core".',
  },
  {
    id: 'prose-in-dogsled',
    category: 'BC-06',
    kind: 'content',
    match: /\bin-dogsled\b/g,
    replace: 'built-in',
    note: '"in-dogsled model judge" -> "built-in model judge".',
  },
  {
    id: 'prose-core',
    category: 'BC-06',
    kind: 'content',
    match: /\bDogsled Core\b/g,
    replace: 'Bobsled Core',
  },
  {
    id: 'prose-managed',
    category: 'BC-06',
    kind: 'content',
    match: /\bDogsled-managed\b/g,
    replace: 'platform-managed',
    note: 'Editorial: managed destinations are run by the host app.',
  },
  {
    id: 'prose-product',
    category: 'BC-06',
    kind: 'content',
    match: /\bDogsled\b(?! Cloud)/g,
    replace: 'Bobsled Core',
    exclude: NOT_HISTORY,
    note: 'Broadest prose rule; editorial pass afterwards ("the bobsled CLI" vs "Bobsled Core").',
  },

  // BC-04 CLI and remaining lowercase word (runs last)
  {
    id: 'cli-regex-literal',
    category: 'BC-04',
    kind: 'content',
    match: '\\bdogsled\\b',
    replace: '\\bbobsled\\b',
    note: 'Regex literals such as /\\bdogsled\\b/ in learn.ts (the word rule skips text after a backslash escape).',
  },
  {
    id: 'cli-and-word',
    category: 'BC-04',
    kind: 'content',
    match: /(?:(?<![\w@-])|(?<=\\n))dogsled(?![\w])(?!\.it)/g,
    replace: 'bobsled',
    exclude: NOT_HISTORY,
    note: 'CLI name (dogsled extract ...), program name, MCP name, bare words.',
  },
];

export function rulesForProfile(profile) {
  if (!profile) return RULES;
  return RULES.filter((r) => !r.profiles || r.profiles.includes(profile));
}

/** Rules matching comma-separated ids or BC-xx categories; `all` (or none) selects every rule. */
export function selectRules(selector, profile) {
  const base = rulesForProfile(profile);
  if (!selector || selector === true || selector === 'all') return base;
  const tokens = Array.isArray(selector)
    ? selector
    : String(selector)
        .split(',')
        .map((s) => s.trim());
  const unknown = tokens.filter((t) => !RULES.some((r) => r.id === t || r.category === t));
  if (unknown.length > 0) throw new Error(`Unknown rule ids or categories: ${unknown.join(', ')}`);
  return base.filter((r) => tokens.includes(r.id) || tokens.includes(r.category));
}

/** Keep-list entries that contain an old name, for masking in the given profile. */
export function maskedKeepList(profile = 'toolkit') {
  return KEEP_LIST.filter(
    (k) => /dogsled/i.test(k.pattern) && (!k.profiles || k.profiles.includes(profile))
  );
}

export const contentRules = (rules) => rules.filter((r) => r.kind === 'content');
export const pathRules = (rules) => rules.filter((r) => r.kind === 'path');
