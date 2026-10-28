import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildEntityGraphDataQuickQueries,
  isEntityGraphDataQuickQuery,
  normalizeEntityGraphDataQuerySql,
} from '../src/lib/entity-graph-data-queries';

test('Entity Graph data quick queries use singular profile tables and scenario-aware defaults', () => {
  assert.deepEqual(buildEntityGraphDataQuickQueries('default')[0], {
    label: 'Entity profiles',
    sql: 'SELECT * FROM entity_graph_demo.company__entity_profile LIMIT 100',
  });
});

test('Entity Graph data quick query helpers normalize only legacy plural profile references', () => {
  assert.equal(
    isEntityGraphDataQuickQuery(
      'SELECT * FROM entity_graph_demo.company__entity_profile LIMIT 100',
      'default'
    ),
    true
  );
  assert.equal(
    isEntityGraphDataQuickQuery(
      'SELECT * FROM entity_graph_demo.company__entity_profiles LIMIT 100',
      'default'
    ),
    true
  );
  assert.equal(
    normalizeEntityGraphDataQuerySql(
      'SELECT * FROM entity_graph_demo.company__entity_profiles LIMIT 100',
      'default'
    ),
    'SELECT * FROM entity_graph_demo.company__entity_profile LIMIT 100'
  );
  assert.equal(
    normalizeEntityGraphDataQuerySql(
      'SELECT * FROM entity_graph_demo.company__entity_profiles_backup',
      'default'
    ),
    'SELECT * FROM entity_graph_demo.company__entity_profiles_backup'
  );
});
