import type { LearnModule } from './learn-curriculum';
import { command, terminalAction } from './learn-module-helpers';

export const ENTITY_GRAPH_SDK_MODULE: LearnModule = {
  id: 'entity-graph-sdk',
  title: 'Entity Graph: Cross-Source Resolution, Mentions, and Typed SDK',
  group: 'entity-graph',
  description:
    'Resolve cross-source entities, link them to document mentions, and generate a typed TypeScript SDK that app code can call against the entity graph.',
  outcome:
    'You can run the end-to-end workflow — resolve entities, export the mention review queue, generate a TypeScript SDK, and wire an executor — and explain what each artifact is for.',
  estimatedMinutes: 30,
  cliPhaseIds: ['entity-graph-sdk'],
  steps: [
    {
      id: 'entity-graph-contracts',
      kind: 'concept',
      title: 'Public schemas before any code',
      body: 'Four locked contracts shape every downstream surface. `__entity_profile` and `__entity_relationship` are the canonical resolved-entity tables. `__document_mentions` carries the chunk→entity links produced by mention extraction, with a span-end-included `mention_id` PK that prevents collisions on overlapping spans. The SDK codegen IR (`ir_version: "1.0"`) is the JSON shape that bridges the entity graph into emitted SDK code. Schemas live in the entity-graph overview guide; versioning is locked — additive columns are minor, renames and deletions are major.',
      cliLessonId: 'entity-graph-contracts',
    },
    {
      id: 'entity-graph-inventory',
      kind: 'concept',
      title: 'Inventory the project',
      body: '`inventoryEntityGraph()` in `@bobsled-inc/entity-graph/api` reads the resolution specs from `entity-graph/` (or `mdm/` for legacy projects) and returns a typed snapshot — entities, relationships, profile attributes, dialect capabilities, and operational warnings. This is the bridge `@bobsled-inc/sdk-codegen` consumes; it is also what an agent calls to inspect a project without spawning the CLI.',
      cliLessonId: 'entity-graph-inventory',
    },
    {
      id: 'entity-graph-resolve-run',
      kind: 'command',
      title: 'Resolve, cluster, and profile entities',
      body: 'The example resolves customers, deals, and documents into one graph. `resolve validate` checks the specs offline, `resolve run` materializes resolution tables, `resolve cluster` collapses pair decisions into clusters, and `resolve profile` builds the `__entity_profile` rows. The `--runner` flag points at a runner module (DuckDB by default) so this works without warehouse credentials.',
      cliLessonId: 'entity-graph-resolve-run',
      command: command('entity-graph', ['resolve', '--help']),
      action: terminalAction(
        'Open Entity Graph Resolve Help',
        command('entity-graph', ['resolve', '--help'])
      ),
    },
    {
      id: 'entity-graph-mention-extraction',
      kind: 'concept',
      title: 'Document mentions — chunks to candidates to resolved',
      body: 'Mention extraction is a two-stage pipeline. Stage 1 retrieves candidates per chunk using per-dialect similarity (DuckDB `jaro_winkler`, Postgres `pg_trgm`, Snowflake `JAROWINKLER_SIMILARITY`, BigQuery shingled join). Stage 1 exact-links only when candidate similarity is > 0.95. Stage 2 asks the LLM to pick one candidate or return `unresolved`: 0.85-0.95 links with `agent_applied`, 0.55-0.85 links with `agent_review`, and <0.55 stays unresolved. Review export labels are separate: >= 0.92 auto-merge, >= 0.75 agent-applied, >= 0.55 agent-review. Prompt-injection markers (`instruction_override`, `unicode_homograph`, `literal_tag_strip`) are detected and recorded - see the Mention Extraction guide.',
      cliLessonId: 'entity-graph-mention-extraction',
    },
    {
      id: 'entity-graph-mention-review-export',
      kind: 'command',
      title: 'Export the mention review queue',
      body: '`dogsled entity-graph mentions review export` returns the rows that need attention (unresolved, low-confidence, or flagged by the compromise/schema-violation fallbacks). CSV is the default to match the existing `model review export` envelope. `--all` includes auto-merges. `--json` and `--yaml` exist for agent consumers; the format auto-resolves through the shared `resolveOutputFormat` helper so `CI=true` and non-TTY runs default to JSON.',
      cliLessonId: 'entity-graph-mention-review-export',
      command: command('entity-graph', ['mentions', 'review', 'export', '--help']),
      action: terminalAction(
        'Open Mention Review Export Help',
        command('entity-graph', ['mentions', 'review', 'export', '--help'])
      ),
    },
    {
      id: 'entity-graph-sdk-ir',
      kind: 'concept',
      title: 'SDK codegen IR — the bridge contract',
      body: 'The codegen IR is a Zod-strict JSON shape with `ir_version: "1.0"`. Entities carry `name`, `primary_key`, `branded_id_type`, `profile_attrs[]`, `quality_columns[]`, and per-entity relationship-name arrays. Relationships are declared or ontology-derived, and ER guarantees forbid orphan endpoints. `polymorphic_groups[]` is a reserved slot — always emitted, empty in v1.0 — so a future minor bump can populate it without a major rev. The IR is what gets piped between `inventoryEntityGraph()` and the TypeScript/Python emitters.',
      cliLessonId: 'entity-graph-sdk-ir',
    },
    {
      id: 'entity-graph-relationship-extraction',
      kind: 'command',
      title: 'Extract and review relationships',
      body: '`relationship_ontology` constrains which predicates can exist, and `relationship_extraction` tells Dogsled which chunks to process. The runtime builds candidate pairs only from resolved mentions, asks the model for span-grounded evidence, rejects hallucinated IDs or excerpt mismatches, appends accepted rows to `__entity_relationship_evidence`, and compacts current state into public `__entity_relationship`. Review uses `relationships review export/apply` and append-only `__entity_relationship_decisions`.',
      cliLessonId: 'entity-graph-relationship-extraction',
      command: command('entity-graph', ['relationships', '--help']),
      action: terminalAction(
        'Open Relationship Workflows Help',
        command('entity-graph', ['relationships', '--help'])
      ),
    },
    {
      id: 'entity-graph-sdk-generate',
      kind: 'command',
      title: 'Generate the typed SDK',
      body: '`dogsled sdk generate --lang ts --out ./generated/dogsled-sdk` writes a complete TypeScript SDK into the consumer repo. The emitted code includes branded ID types (e.g. `type CustomerId = string & { readonly __brand: "CustomerId" }`), per-entity `Profile` interfaces, strict `FindFilter` shapes, an executor-backed `EntityQueryBuilder`, and a `createBobsledClient()` factory. Generated code targets `tsc >=5.0 <5.5` and is `tsc --noEmit`-clean. Python output is supported as a library export today; the v1 CLI ships TypeScript only.',
      cliLessonId: 'entity-graph-sdk-generate',
      command: command('sdk', ['--help']),
      action: terminalAction('Open SDK Generate Help', command('sdk', ['--help'])),
    },
    {
      id: 'entity-graph-executor-contract',
      kind: 'concept',
      title: 'Executor contract — what app code provides',
      body: 'The generated SDK does not embed a database driver. The consumer passes in a `BobsledEntityExecutor` — a single `find(request)` function whose request carries `{ entity, filter, includes, limit }` and whose response is `Array<EntityFindResult>` containing `{ profile, documents, relationships }`. The executor can bridge to Dogsled MCP `readSource`, a warehouse runner, or an app API — the SDK only cares about the typed shape. This is what keeps the SDK pure transformation (IR → emitted code) and lets the consumer own execution context.',
      cliLessonId: 'entity-graph-executor-contract',
    },
    {
      id: 'entity-graph-typed-query',
      kind: 'concept',
      title: 'Typed query in app code',
      body: 'With the executor wired, app code calls the typed surface: `dogsled.entity.customer.findBy({ domain: "acme.com" }).withDocuments().withRelationship("competes_with").first()`. `findBy` requires the strict per-entity filter shape (extra keys are rejected at compile time). `withDocuments()` and `withRelationship(name)` are include builders; relationship names are generated as per-entity literal unions and backed by a runtime allowlist. `first()` is sugar over `limit(1).all()` and returns `null` instead of an empty array. Every returned profile carries `_quality: EntityQuality` so callers can branch on confidence, freshness, and source diversity.',
      cliLessonId: 'entity-graph-typed-query',
    },
  ],
};
