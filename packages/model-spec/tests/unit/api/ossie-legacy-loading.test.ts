import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

import { compileProject } from '../../../src/api/compile-project.js';
import { loadProject } from '../../../src/api/load-project.js';
import { validateProject } from '../../../src/api/validate-project.js';
import { translateOssieDocument } from '../../../src/ossie/index.js';

const fixtureDir = fileURLToPath(new URL('../../fixtures/ossie-native-legacy/', import.meta.url));
const roots: string[] = [];
afterEach(() =>
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }))
);

describe('legacy direct Ossie reader', () => {
  it('validates schema, metadata references, output addresses, and the compiled project', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ossie-docs-'));
    roots.push(root);
    fs.cpSync(fixtureDir, root, { recursive: true });
    const integration = parse(fs.readFileSync(path.join(root, 'warehouse.yml'), 'utf8'));
    integration.auth.path = path.join(root, 'orders.duckdb');
    fs.writeFileSync(path.join(root, 'warehouse.yml'), stringify(integration));
    const doc = parse(fs.readFileSync(path.join(root, 'sales.yml'), 'utf8'));
    expect(translateOssieDocument(doc, 'sales.yml').entries.map((entry) => entry.kind)).toEqual([
      'source',
      'source',
      'model',
      'model',
      'metric',
      'relationship',
    ]);
    const project = await loadProject(root);
    const checked = await validateProject(root, { project });
    expect(checked.ok).toBe(true);
    expect(project.entities.metrics.size).toBe(1);
    expect(project.entities.relationships.size).toBe(1);
    const compiled = await compileProject(root, { project });
    expect(compiled.ok).toBe(true);
    expect(
      compiled.byIntegration
        .flatMap((group) => group.results)
        .map((result) => result.modelName)
        .sort()
    ).toEqual(['clean_orders', 'customers']);
  });
});
