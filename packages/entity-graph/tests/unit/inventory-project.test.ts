import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { CommandError } from '@bobsled-inc/protocol';

import { inventoryEntityGraph, SDK_IR_VERSION } from '../../src/api/inventory-project.js';

function writeFile(dir: string, file: string, body: string): string {
  const full = path.join(dir, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
}

describe('inventoryEntityGraph', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-inventory-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits ir_version 1.0 with reserved polymorphic_groups slot', async () => {
    writeFile(tmpDir, 'model-spec.yml', `mdm_dir: entity-graph\n`);
    writeFile(
      tmpDir,
      'integrations/duckdb.yml',
      `spec_version: '1'\ntype: integration\nname: duckdb\nsource_type: duckdb\nconnection:\n  schema: main\nauth:\n  type: file\n  path: test.duckdb\n`
    );
    writeFile(
      tmpDir,
      'entity-graph/customer.yml',
      `spec_version: '0.2'
name: customer
type: resolution
description: Customer resolution fixture for inventoryEntityGraph test.

inputs:
  - ref: crm.customers
    role: internal
    trust_tier: silver
    id_fields: [customer_id]

standardize:
  - field: email
    transforms: [lowercase, trim]

blocking:
  rules:
    - name: exact_email
      key: standardized_email

deterministic_rules:
  - name: exact_email_match
    conditions:
      - field: standardized_email
        operator: exact
        both_not_null: true
    action: auto_merge
    confidence: 1.0

scoring:
  method: weighted_features
  features:
    - field: standardized_email
      algorithm: jaro_winkler
      weight: 1.0

thresholds:
  auto_merge: 0.92
  agent_review: 0.75
  human_review: 0.55
  auto_reject: 0.3
`
    );

    const inventory = await inventoryEntityGraph({ cwd: tmpDir, integration: 'duckdb' });

    expect(inventory.ir_version).toBe(SDK_IR_VERSION);
    expect(inventory.polymorphic_groups).toEqual([]);
    expect(inventory.entities.length).toBeGreaterThan(0);
    expect(inventory.entities[0]?.name).toBe('customer');
    expect(inventory.entities[0]?.branded_id_type).toBe('CustomerId');
    expect(inventory.entities[0]?.quality_columns).toEqual([
      'confidence',
      'freshness_age_seconds',
      'source_diversity',
      'profile_coverage',
    ]);
    // Scoring-feature fallback projects `standardized_email` since the
    // spec has scoring but no explicit profile block.
    expect(inventory.entities[0]?.profile_attrs).toEqual([
      { name: 'standardized_email', type: 'string', nullable: true },
    ]);
    expect(inventory.relationships).toEqual([]);
    expect(inventory.entities[0]?.relationships_as_left).toEqual([]);
    expect(inventory.entities[0]?.relationships_as_right).toEqual([]);
  });

  it('projects profile_attrs from explicit profile block when present', async () => {
    writeFile(tmpDir, 'model-spec.yml', `mdm_dir: entity-graph\n`);
    writeFile(
      tmpDir,
      'integrations/duckdb.yml',
      `spec_version: '1'\ntype: integration\nname: duckdb\nsource_type: duckdb\nconnection:\n  schema: main\nauth:\n  type: file\n  path: test.duckdb\n`
    );
    writeFile(
      tmpDir,
      'entity-graph/customer.yml',
      `spec_version: '0.2'
name: customer
type: resolution
description: Customer with explicit profile.

inputs:
  - ref: crm.customers
    role: internal
    trust_tier: silver
    id_fields: [customer_id]

standardize:
  - field: email
    transforms: [lowercase, trim]

blocking:
  rules:
    - name: exact_email
      key: standardized_email

deterministic_rules:
  - name: exact_email_match
    conditions:
      - field: standardized_email
        operator: exact
        both_not_null: true
    action: auto_merge
    confidence: 1.0

scoring:
  method: weighted_features
  features:
    - field: standardized_email
      algorithm: jaro_winkler
      weight: 1.0

thresholds:
  auto_merge: 0.92
  agent_review: 0.75
  human_review: 0.55
  auto_reject: 0.3

profile:
  display_name:
    field: company_name
  attributes:
    - field: company_name
      alias: company_name
    - field: domain
      alias: primary_domain
`
    );

    const inventory = await inventoryEntityGraph({ cwd: tmpDir, integration: 'duckdb' });
    expect(inventory.entities[0]?.profile_attrs).toEqual([
      { name: 'company_name', type: 'string', nullable: true },
      { name: 'primary_domain', type: 'string', nullable: true },
    ]);
  });

  it('exposes empty warnings when projection is clean', async () => {
    writeFile(tmpDir, 'model-spec.yml', `mdm_dir: entity-graph\n`);
    writeFile(
      tmpDir,
      'integrations/duckdb.yml',
      `spec_version: '1'\ntype: integration\nname: duckdb\nsource_type: duckdb\nconnection:\n  schema: main\nauth:\n  type: file\n  path: test.duckdb\n`
    );
    writeFile(
      tmpDir,
      'entity-graph/customer.yml',
      `spec_version: '0.2'
name: customer
type: resolution
description: Clean projection.

inputs:
  - ref: crm.customers
    role: internal
    trust_tier: silver
    id_fields: [customer_id]

standardize: []

blocking:
  rules:
    - name: r
      key: customer_id

deterministic_rules:
  - name: m
    conditions:
      - field: customer_id
        operator: exact
        both_not_null: true
    action: auto_merge
    confidence: 1.0

scoring:
  method: weighted_features
  features:
    - field: customer_id
      algorithm: exact
      weight: 1.0

thresholds:
  auto_merge: 0.92
  agent_review: 0.75
  human_review: 0.55
  auto_reject: 0.3
`
    );

    const inventory = await inventoryEntityGraph({ cwd: tmpDir, integration: 'duckdb' });
    expect(inventory.warnings).toEqual([]);
  });

  it('projects relationships and drops edges with unknown endpoints', async () => {
    writeFile(tmpDir, 'model-spec.yml', `mdm_dir: entity-graph\n`);
    writeFile(
      tmpDir,
      'integrations/duckdb.yml',
      `spec_version: '1'\ntype: integration\nname: duckdb\nsource_type: duckdb\nconnection:\n  schema: main\nauth:\n  type: file\n  path: test.duckdb\n`
    );
    writeFile(
      tmpDir,
      'entity-graph/customer.yml',
      `spec_version: '0.2'
name: customer
type: resolution
description: Customer.

inputs:
  - ref: crm.customers
    role: internal
    trust_tier: silver
    id_fields: [customer_id]

standardize:
  - field: email
    transforms: [lowercase, trim]

blocking:
  rules:
    - name: r
      key: standardized_email

deterministic_rules:
  - name: m
    conditions:
      - field: standardized_email
        operator: exact
        both_not_null: true
    action: auto_merge
    confidence: 1.0

scoring:
  method: weighted_features
  features:
    - field: standardized_email
      algorithm: jaro_winkler
      weight: 1.0

thresholds:
  auto_merge: 0.92
  agent_review: 0.75
  human_review: 0.55
  auto_reject: 0.3
`
    );
    writeFile(
      tmpDir,
      'entity-graph/document.yml',
      `spec_version: '0.2'
name: document
type: resolution
description: Document.

inputs:
  - ref: docs.documents
    role: internal
    trust_tier: silver
    id_fields: [document_id]

standardize: []

blocking:
  rules:
    - name: r
      key: document_id

deterministic_rules:
  - name: m
    conditions:
      - field: document_id
        operator: exact
        both_not_null: true
    action: auto_merge
    confidence: 1.0

scoring:
  method: weighted_features
  features:
    - field: document_id
      algorithm: exact
      weight: 1.0

thresholds:
  auto_merge: 0.92
  agent_review: 0.75
  human_review: 0.55
  auto_reject: 0.3
`
    );
    writeFile(
      tmpDir,
      'entity-graph/customer_to_document.yml',
      `spec_version: '0.2'
type: entity_relationship
name: customer_mentions_document
description: Mention edge.
left_entity: customer
right_entity: document
relationship_type: one_to_many
join_type: inner
join_columns:
  - left: entity_id
    right: resolved_entity_id
review:
  thresholds:
    auto_confirm: 0.92
    review: 0.55
    auto_reject: 0.3
`
    );
    writeFile(
      tmpDir,
      'entity-graph/orphan_relationship.yml',
      `spec_version: '0.2'
type: entity_relationship
name: customer_to_missing
description: Orphan edge dropped because right entity is unknown.
left_entity: customer
right_entity: missing_entity
relationship_type: one_to_one
join_type: inner
join_columns:
  - left: entity_id
    right: entity_id
review:
  thresholds:
    auto_confirm: 0.92
    review: 0.55
    auto_reject: 0.3
`
    );

    const inventory = await inventoryEntityGraph({ cwd: tmpDir, integration: 'duckdb' });
    expect(inventory.entities.map((e) => e.name).sort()).toEqual(['customer', 'document']);
    expect(inventory.relationships).toEqual([
      {
        name: 'customer_mentions_document',
        left_entity: 'customer',
        right_entity: 'document',
        cardinality: 'one_to_many',
        join_attrs: [{ left: 'entity_id', right: 'resolved_entity_id' }],
      },
    ]);
    const customer = inventory.entities.find((entity) => entity.name === 'customer');
    const document = inventory.entities.find((entity) => entity.name === 'document');
    expect(customer?.relationships_as_left).toEqual(['customer_mentions_document']);
    expect(document?.relationships_as_right).toEqual(['customer_mentions_document']);
    // The orphan-endpoint relationship surfaces as a warning so the
    // operator sees what was skipped rather than silently dropped.
    expect(inventory.warnings).toEqual([
      "Skipping relationship 'customer_to_missing' — endpoint(s) not in inventory entities (left='customer', right='missing_entity').",
    ]);
  });

  it('projects relationship ontology metadata and per-entity relation names', async () => {
    writeFile(tmpDir, 'model-spec.yml', `mdm_dir: entity-graph\n`);
    writeFile(
      tmpDir,
      'integrations/duckdb.yml',
      `spec_version: '1'\ntype: integration\nname: duckdb\nsource_type: duckdb\nconnection:\n  schema: main\nauth:\n  type: file\n  path: test.duckdb\n`
    );
    writeFile(
      tmpDir,
      'entity-graph/customer.yml',
      `spec_version: '0.2'
name: customer
type: resolution
description: Customer.

inputs:
  - ref: crm.customers
    role: internal
    trust_tier: silver
    id_fields: [customer_id]

standardize: []

blocking:
  rules:
    - name: r
      key: customer_id

deterministic_rules:
  - name: m
    conditions:
      - field: customer_id
        operator: exact
        both_not_null: true
    action: auto_merge
    confidence: 1.0

scoring:
  method: weighted_features
  features:
    - field: customer_id
      algorithm: exact
      weight: 1.0

thresholds:
  auto_merge: 0.92
  agent_review: 0.75
  human_review: 0.55
  auto_reject: 0.3
`
    );
    writeFile(
      tmpDir,
      'entity-graph/ontology.yml',
      `spec_version: '0.2'
type: relationship_ontology
name: default
relations:
  - relation_type: competes_with
    description: Customers selling into the same market.
    left_entity: customer
    right_entity: customer
    direction: symmetric
    cardinality: many_to_many
    exclusive_with: [partners_with]
    temporal: stateful
    review_thresholds:
      auto_confirm: 0.92
      review: 0.55
      auto_reject: 0.3
  - relation_type: partners_with
    description: Customers cooperating on a deal.
    left_entity: customer
    right_entity: customer
    direction: symmetric
    cardinality: many_to_many
    exclusive_with: [competes_with]
    temporal: stateful
    review_thresholds:
      auto_confirm: 0.92
      review: 0.55
      auto_reject: 0.3
`
    );
    writeFile(
      tmpDir,
      'entity-graph/relationship-extraction.yml',
      `spec_version: '0.2'
type: relationship_extraction
name: business_relations
ontology_ref: default
extraction:
  role: relationship_extraction_v1
  prompt_version: v1
`
    );

    const inventory = await inventoryEntityGraph({ cwd: tmpDir, integration: 'duckdb' });
    expect(inventory.ontology).toEqual({
      name: 'default',
      ontology_version: 'default@0.2',
      relation_types: ['competes_with', 'partners_with'],
      entity_types: ['customer'],
    });
    expect(inventory.entities[0]?.relationships_as_left).toEqual([
      'competes_with',
      'partners_with',
    ]);
    expect(inventory.entities[0]?.relationships_as_right).toEqual([
      'competes_with',
      'partners_with',
    ]);
  });

  it('rejects projects with no specs via CommandError(2)', async () => {
    writeFile(tmpDir, 'model-spec.yml', `mdm_dir: entity-graph\n`);
    writeFile(
      tmpDir,
      'integrations/duckdb.yml',
      `spec_version: '1'\ntype: integration\nname: duckdb\nsource_type: duckdb\nconnection:\n  schema: main\nauth:\n  type: file\n  path: test.duckdb\n`
    );
    fs.mkdirSync(path.join(tmpDir, 'entity-graph'), { recursive: true });

    // Single invocation — assert message + CommandError shape together
    // instead of running the expensive inventory twice.
    let caught: unknown;
    try {
      await inventoryEntityGraph({ cwd: tmpDir, integration: 'duckdb' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CommandError);
    expect((caught as CommandError).exitCode).toBe(2);
    expect((caught as Error).message).toMatch(/No resolution specs found/);
  });
});
