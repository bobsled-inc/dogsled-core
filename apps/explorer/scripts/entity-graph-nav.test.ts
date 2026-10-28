import assert from 'node:assert/strict';
import test from 'node:test';
import { getEntityGraphSubnavState } from '../src/lib/entity-graph-nav';

test('Entity Graph overview route shows subnav and marks Overview active', () => {
  const nav = getEntityGraphSubnavState('/entity-graph');

  assert.equal(nav.visible, true);
  assert.equal(nav.items.find((item) => item.label === 'Overview')?.active, true);
  assert.equal(nav.items.find((item) => item.label === 'Design')?.active, false);
  assert.equal(nav.items.find((item) => item.label === 'Resolve')?.active, false);
});

test('Entity Graph nested routes activate the matching subnav item', () => {
  const designNav = getEntityGraphSubnavState('/entity-graph/design');
  const clustersNav = getEntityGraphSubnavState('/entity-graph/resolve/clusters/123');

  assert.equal(designNav.visible, true);
  assert.equal(designNav.items.find((item) => item.label === 'Design')?.active, true);
  assert.equal(clustersNav.visible, true);
  assert.equal(clustersNav.items.find((item) => item.label === 'Resolve')?.active, true);
});

test('Non-entity-graph lookalike routes do not show entity graph subnav or activate links', () => {
  const nav = getEntityGraphSubnavState('/entity-graph2');

  assert.equal(nav.visible, false);
  assert.ok(nav.items.every((item) => item.active === false));
});
