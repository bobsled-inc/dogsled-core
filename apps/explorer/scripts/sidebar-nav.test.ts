import assert from 'node:assert/strict';
import test from 'node:test';

// Import the NAV_ITEMS type shape by reading the file directly — we only need
// the data, not the React component that uses client hooks.
import { NAV_ITEMS } from '../src/components/layout/sidebar-nav-items';

test('Dashboard has no section label (null group)', () => {
  const dashboard = NAV_ITEMS.find((item) => item.href === '/');
  assert.ok(dashboard, 'Dashboard item exists');
  assert.equal(dashboard.group, null);
});

test('EXPLORE section starts at Integrations', () => {
  const integrations = NAV_ITEMS.find((item) => item.href === '/integrations');
  assert.ok(integrations, 'Integrations item exists');
  assert.equal(integrations.group, 'EXPLORE');
});

test('EXPLORE section includes Learn as the primary teaching entrypoint', () => {
  const learn = NAV_ITEMS.find((item) => item.href === '/learn');
  assert.ok(learn, 'Learn item exists');
  assert.equal(learn.group, 'EXPLORE');
  assert.equal(learn.label, 'Learn');
});

test('OPERATE section contains the local pipeline builder, Connections, and Data', () => {
  const pipelines = NAV_ITEMS.find((item) => item.href === '/pipelines/new');
  assert.ok(pipelines, 'Pipelines item exists');
  assert.equal(pipelines.group, 'OPERATE');
  const connections = NAV_ITEMS.find((item) => item.href === '/operate/connections');
  assert.ok(connections, 'Connections item exists');
  assert.equal(connections.group, 'OPERATE');
  const data = NAV_ITEMS.find((item) => item.href === '/operate/data');
  assert.ok(data, 'Data item exists');
  assert.equal(data.group, 'OPERATE');
});

test('Entity Graph section has Overview, Design, Resolve, and Data items', () => {
  const overview = NAV_ITEMS.find((item) => item.href === '/entity-graph');
  assert.ok(overview, 'Entity Graph Overview item exists');
  assert.equal(overview.group, 'ENTITY GRAPH');
  const design = NAV_ITEMS.find((item) => item.href === '/entity-graph/design');
  assert.ok(design, 'Entity Graph Design item exists');
  assert.equal(design.group, 'ENTITY GRAPH');
  const resolve = NAV_ITEMS.find((item) => item.href === '/entity-graph/resolve');
  assert.ok(resolve, 'Entity Graph Resolve item exists');
  assert.equal(resolve.group, 'ENTITY GRAPH');
  const data = NAV_ITEMS.find((item) => item.href === '/entity-graph/data');
  assert.ok(data, 'Entity Graph Data item exists');
  assert.equal(data.group, 'ENTITY GRAPH');
});

test('navigation has no retired runner controls', () => {
  const hrefs: readonly string[] = NAV_ITEMS.map((item) => item.href);
  for (const retired of ['/pipelines', '/operate/runs', '/settings'])
    assert.equal(hrefs.includes(retired), false);
});

test('all groups are valid values', () => {
  const validGroups = new Set(['EXPLORE', 'OPERATE', 'ENTITY GRAPH', 'DEMO', 'separator', null]);
  for (const item of NAV_ITEMS) {
    assert.ok(
      validGroups.has(item.group),
      `Item ${item.href} has unexpected group: ${String(item.group)}`
    );
  }
});
