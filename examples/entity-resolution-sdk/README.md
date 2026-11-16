# Entity Graph + Typed SDK Example

This example shows the intended application shape for cross-source entity resolution, mention extraction, relationship evidence, and the typed SDK without requiring live warehouse credentials. The walkthrough uses a local DuckDB runner seeded from `fixtures/seed.sql`.

## Goal

Resolve customers, deals, and documents into one entity graph. Link unstructured chunks (PDFs, transcripts) back to those resolved entities via mention extraction. Query the result from typed application code with `_quality` scores attached to every profile.

## Commands

```bash
./walkthrough.sh
```

The script validates the entity graph specs, runs real mention extraction through the credential-free `compromise` fallback, writes document-derived relationship evidence, compacts it, generates the SDK, and verifies a typed SDK query against the seeded DuckDB data.

Manual commands:

```bash
# 1. Validate core entity specs. The local runner seeds profile tables for the demo.
dogsled entity-graph resolve validate customer deal document --json

# 2. Extract document mentions, then export ambiguous rows for review.
dogsled entity-graph mentions extract Customer \
  --runner ./runner.js \
  --schema entity_graph \
  --fallback compromise \
  --json
dogsled entity-graph mentions review export \
  --runner ./runner.js \
  --schema entity_graph \
  --csv \
  > ./review/document_mentions.csv

# 3. Extract, review, and compact document-derived relationships.
dogsled entity-graph relationships extract Customer \
  --runner ./runner.js \
  --schema entity_graph \
  --fallback compromise \
  --json
dogsled entity-graph relationships review export \
  --runner ./runner.js \
  --schema entity_graph \
  --yaml \
  > ./review/relationship_decisions.yml
# Edit ./review/relationship_decisions.yml with confirm/reject/supersede/conflicted decisions.
dogsled entity-graph relationships review apply ./review/relationship_decisions.yml \
  --runner ./runner.js \
  --json
dogsled entity-graph relationships compact \
  --runner ./runner.js \
  --schema entity_graph \
  --json

# 4. Generate the app-local TypeScript SDK.
dogsled sdk generate --lang ts --out ./generated/dogsled-sdk --json

# 5. Verify generated SDK calls against the seeded local graph.
pnpm exec tsx src/verify.ts
```

## App Code

```ts
import { createBobsledClient, type BobsledEntityExecutor } from './generated/dogsled-sdk/index.js';

const executor: BobsledEntityExecutor = {
  async find(request) {
    // request looks like:
    //   {
    //     entity: 'customer',
    //     filter: { domain: 'acme.com' },
    //     includes: { documents: true, relationships: ['customer_has_deal'] },
    //     limit: 1,
    //   }
    return queryBobsledEntityGraph(request);
  },
};

const dogsled = createBobsledClient(executor);

const acme = await dogsled.entity.customer
  .findBy({ domain: 'acme.com' })
  .withDocuments()
  .withRelationship('customer_has_deal')
  .first();

if (acme) {
  renderAccountPage({
    customer: acme.profile,
    documents: acme.documents,
    quality: acme.profile._quality, // confidence, freshness, source_diversity, profile_coverage
  });
}
```

The executor returns `Array<EntityFindResult>`. `.first()` is sugar over `.limit(1).all()` and returns `null` instead of an empty array.

## Mention Review Output

`mentions review export` reuses the standard `model review export` envelope (`review_id`, `decision`, `confidence`), then appends mention-specific columns:

```csv
review_id,decision,confidence,mention_id,chunk_id,document_id,entity_type,entity_name,resolved_entity_id,resolution_method,notes
m_001,human_review,0.72,m_001,c_001,d_001,company,Acme,customer_123,llm_disambiguation,"{""review_flag"":true}"
```

Agents should prefer `--json` or `--yaml` when consuming this queue directly. CSV is for spreadsheet review.

## What's Demonstrated

| Capability                               | Where it shows up                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| Cross-source entity resolution           | `resolve run / cluster / profile` materializes `__entity_profile`.        |
| Unstructured → structured linking        | `__document_mentions` rows attach chunk evidence to `resolved_entity_id`. |
| Declared relationships (no orphans)      | `customer_has_deal` traversal via `.withRelationship()`.                  |
| Document-derived relationships           | `relationships extract --fallback compromise` and compact.                |
| Quality scoring on every result          | `acme.profile._quality.{confidence,freshness_age_seconds,...}`.           |
| Typed app-code surface                   | Branded `CustomerId`, strict `findBy` filter shapes.                      |
| Executor-backed SDK (no embedded driver) | The consumer-supplied `BobsledEntityExecutor`.                            |
| Review queue for low-confidence mentions | `mentions review export` envelope.                                        |

## Related Guides

- [Entity graph](../../docs/guides/entity-graph.md)
- [Mention Extraction](../../docs/reference/advanced/mention-extraction.md)
- [Relationship Extraction](../../docs/reference/advanced/relationship-extraction.md)
- [SDK Codegen](../../docs/reference/advanced/sdk-codegen.md)
- [MCP `read_source`](../../docs/reference/advanced/mcp-read-source.md)
- [Embeddings and AI providers](../../docs/guides/embeddings-and-ai.md)
