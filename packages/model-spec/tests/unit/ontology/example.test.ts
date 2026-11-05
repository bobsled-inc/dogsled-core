import { importOntologyDocuments } from '../../../src/ontology/conversion.js';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { scanProject, indexProjectFiles } from '@bobsled-inc/project-index';
import { loadOntologyCatalog } from '../../../src/ontology/index.js';
import { exportOssieDocuments } from '../../../src/interchange/export.js';
it('validates and exports the complete documented example without credentials', () => {
  const index = scanProject(
    fileURLToPath(new URL('../../fixtures/customer-ontology', import.meta.url))
  );
  const catalog = loadOntologyCatalog(index);
  expect(catalog.entries).toHaveLength(2);
  expect(catalog.diagnostics).toEqual([]);
  const result = exportOssieDocuments(index.entries, { ossieVersion: '0.2.0.dev0', strict: true });
  expect(result.ok).toBe(true);
  expect(result.files).toHaveLength(3);
});

it('imports a bundled export with bindings that resolve to the imported sources', () => {
  const index = scanProject(
    fileURLToPath(new URL('../../fixtures/customer-ontology', import.meta.url))
  );
  const exported = exportOssieDocuments(index.entries, { ossieVersion: '0.2.0.dev0' });
  const imported = importOntologyDocuments(exported.files);
  expect(imported.ok).toBe(true);
  expect(imported.ready).toBe(true);
  const loaded = loadOntologyCatalog(indexProjectFiles(imported.files));
  expect(loaded.diagnostics).toEqual([]);
});
