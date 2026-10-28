import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { scanProject } from '@bobsled-inc/project-index';
import { checkProjectModelReferences } from '../../../src/runtime/doctor/project-models.js';
const roots: string[] = [];
function project(source: boolean) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dogsled-doctor-models-'));
  roots.push(root);
  mkdirSync(path.join(root, 'models'));
  writeFileSync(
    path.join(root, 'models/orders.yml'),
    `spec_version: '0.2'\ntype: model\nname: order_summary\ndescription: Fictional orders.\ngrain: [id]\nsource: {ref: local_db.orders}\ncolumns: [{name: id, expr: id}]\nmaterialization: {type: view}\n`
  );
  if (source) {
    mkdirSync(path.join(root, 'sources'));
    writeFileSync(
      path.join(root, 'sources/orders.yml'),
      `spec_version: '0.2'\ntype: source\nname: orders\ndescription: Fictional orders.\nsource_type: warehouse_table\nconnection: local_db\ntable: main.orders\nschema:\n  columns: [{name: id, type: INTEGER}]\n`
    );
  }
  return scanProject(root);
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('reports a missing model source without opening a warehouse connection', () => {
  expect(checkProjectModelReferences(project(false))).toEqual([
    expect.objectContaining({
      status: 'error',
      message: expect.stringContaining('local_db.orders'),
    }),
  ]);
});
it('accepts the same model when its declared source exists', () => {
  expect(checkProjectModelReferences(project(true))).toEqual([
    expect.objectContaining({ status: 'ok' }),
  ]);
});
