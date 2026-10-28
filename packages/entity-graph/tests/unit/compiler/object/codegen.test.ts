import { describe, expect, it } from 'vitest';

import { generateObjectTypesSql } from '../../../../src/compiler/object/codegen.js';
import type { ResolvedObjectSpec } from '../../../../src/compiler/object/types.js';

const OBJECTS: ResolvedObjectSpec[] = [
  {
    name: 'company',
    identityResolutionRef: './company_resolution.yml',
    links: [
      {
        relationRef: './works_at.entity-relationship.yml',
        relationName: 'works_at',
        direction: 'inbound',
      },
    ],
    actions: [],
  },
  {
    name: 'contact',
    identityResolutionRef: './contact_resolution.yml',
    links: [
      {
        relationRef: './works_at.entity-relationship.yml',
        relationName: 'works_at',
        direction: 'outbound',
      },
    ],
    actions: [],
  },
];

describe('generateObjectTypesSql', () => {
  it('emits entity_graph.object_types with links and empty actions', () => {
    const statement = generateObjectTypesSql(OBJECTS, 'duckdb');

    expect(statement.name).toBe('entity_graph_object_types');
    expect(statement.sql).toContain('"entity_graph"."object_types"');
    expect(statement.sql).toContain("'company'");
    expect(statement.sql).toContain('"identity_resolution_ref"');
    expect(statement.sql).toContain('"links_json"');
    expect(statement.sql).toContain('"actions_json"');
    expect(statement.sql).toContain('"relation_name":"works_at"');
    expect(statement.sql).toContain("'[]'");
  });

  it('emits a typed empty select when no object specs exist', () => {
    const statement = generateObjectTypesSql([], 'postgres');

    expect(statement.sql).toContain('WHERE 1 = 0');
    expect(statement.sql).toContain('"entity_graph"."object_types"');
  });

  it('serialises non-empty actions into actions_json', () => {
    const OBJECTS_WITH_ACTIONS: ResolvedObjectSpec[] = [
      {
        name: 'contact',
        identityResolutionRef: './contact_resolution.yml',
        links: [],
        actions: [{ actionRef: './salesforce_contacts.action.yml', label: 'Sync to Salesforce' }],
      },
    ];
    const statement = generateObjectTypesSql(OBJECTS_WITH_ACTIONS, 'duckdb');

    expect(statement.sql).toContain('"entity_graph"."object_types"');
    expect(statement.sql).toContain('"actions_json"');
    expect(statement.sql).toContain('"action_ref":"./salesforce_contacts.action.yml"');
    expect(statement.sql).toContain('"label":"Sync to Salesforce"');
  });
});
