import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildEntityGraphCompareSelectList,
  buildEntityGraphMemberSelectList,
  formatEntityGraphValue,
  getEntityGraphEntityDefinition,
  readEntityGraphSelection,
  resolveEntityGraphScenarioEntity,
} from '../src/lib/entity-graph-scenarios';

test('resolveEntityGraphScenarioEntity rejects unsupported scenarios when one is explicitly provided', () => {
  assert.throws(
    () => resolveEntityGraphScenarioEntity('bogus', 'company'),
    /Unsupported Entity Graph scenario "bogus"/
  );
});

test('resolveEntityGraphScenarioEntity still defaults missing scenario and entity to the company sandbox', () => {
  const resolved = resolveEntityGraphScenarioEntity(null, null);

  assert.equal(resolved.scenarioId, 'default');
  assert.equal(resolved.entityId, 'company');
  assert.equal(resolved.scenario.defaultEntity, 'company');
  assert.equal(resolved.entity.defaultResolutionSpec, 'company_resolution');
});

test('readEntityGraphSelection falls back only for invalid selection input', () => {
  const selection = readEntityGraphSelection({
    get(name: string) {
      if (name === 'scenario') return 'aurelia';
      if (name === 'entity') return 'company';
      return null;
    },
  });

  assert.deepEqual(selection, { scenarioId: 'default', entityId: 'company' });
});

test('formatEntityGraphValue formats numbers with deterministic en-US separators', () => {
  assert.equal(formatEntityGraphValue(1234567, 'number'), '1,234,567');
});

test('buildEntityGraphCompareSelectList quotes the table alias to block identifier injection', () => {
  const entity = getEntityGraphEntityDefinition('company');
  const fragments = buildEntityGraphCompareSelectList(entity, 'evil"; DROP TABLE users--', 'a');
  for (const fragment of fragments) {
    // The alias should be wrapped in double quotes, with interior quotes doubled.
    assert.match(fragment, /^"evil""; DROP TABLE users--"\./);
  }
});

test('buildEntityGraphMemberSelectList quotes the table alias to block identifier injection', () => {
  const entity = getEntityGraphEntityDefinition('company');
  const fragments = buildEntityGraphMemberSelectList(entity, 'a"; --');
  for (const fragment of fragments) {
    assert.match(fragment, /^"a""; --"\./);
  }
});
