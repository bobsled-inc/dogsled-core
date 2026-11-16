import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';
import { describe, expect, it } from 'vitest';

import { IntegrationSpecSchema, ResourceSpecSchema } from '../../src/framework/extractor/index.js';
import { isFileStorageSource } from '../../src/runtime/file-storage-extractor.js';

// Guards the bundled `s3-documents-ingestion` example project (in the `bobsled`
// package) against schema drift: a typo in its integration or resource YAML
// fails here in CI instead of silently shipping a broken example.
const exampleDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'bobsled-core',
  'examples',
  's3-documents-ingestion'
);

function loadYaml(relPath: string): unknown {
  return YAML.parse(readFileSync(join(exampleDir, relPath), 'utf8'));
}

describe('s3-documents-ingestion example project', () => {
  it.each(['integrations/s3_documents.yml', 'integrations/gcs_documents.yml'])(
    'integration %s is a valid file-storage source',
    (rel) => {
      const parsed = IntegrationSpecSchema.safeParse(loadYaml(rel));
      if (!parsed.success) {
        throw new Error(
          `${rel} failed validation:\n${JSON.stringify(parsed.error.issues, null, 2)}`
        );
      }
      expect(isFileStorageSource(parsed.data)).toBe(true);
    }
  );

  it.each(['resources/s3_documents/documents.yml', 'resources/gcs_documents/documents.yml'])(
    'resource %s validates against ResourceSpecSchema',
    (rel) => {
      const parsed = ResourceSpecSchema.safeParse(loadYaml(rel));
      if (!parsed.success) {
        throw new Error(
          `${rel} failed validation:\n${JSON.stringify(parsed.error.issues, null, 2)}`
        );
      }
      expect(parsed.success).toBe(true);
    }
  );
});
