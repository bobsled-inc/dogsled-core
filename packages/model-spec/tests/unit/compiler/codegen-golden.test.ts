import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { generateSql } from '../../../src/compiler/codegen.js';
import { SUPPORTED_DIALECTS } from '../../../src/compiler/dialect.js';
import { buildSourceRegistry, parseTransformSpec } from '../../../src/compiler/parser.js';

const FIXTURES_DIR = path.resolve(__dirname, '../../fixtures/specs');
const SOURCES_DIR = path.join(FIXTURES_DIR, 'sources');
const MODELS_DIR = path.join(FIXTURES_DIR, 'models');
const SNAPSHOT_DIR = path.resolve(__dirname, '__snapshots__');
const DIALECTS = SUPPORTED_DIALECTS;
const MODELS = ['stg_orders', 'order_items'] as const;

const registryResult = buildSourceRegistry(SOURCES_DIR);
if (!registryResult.ok) {
  throw new Error(`Failed to build source registry for golden SQL tests: ${registryResult.error}`);
}

function normalizeSql(sql: string): string {
  return (
    sql
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .join('\n') + '\n'
  );
}

describe('codegen golden files', () => {
  for (const modelName of MODELS) {
    for (const dialect of DIALECTS) {
      it(`${modelName} matches the ${dialect} golden file`, async () => {
        const parseResult = parseTransformSpec(
          path.join(MODELS_DIR, `${modelName}.yml`),
          registryResult.registry
        );
        if (!parseResult.ok) {
          throw new Error(`Failed to parse ${modelName}.yml for ${dialect}: ${parseResult.error}`);
        }

        const sql = normalizeSql(generateSql(parseResult.spec, 'DOGSLED_WORKSPACE', dialect));
        await expect(sql).toMatchFileSnapshot(
          path.join(SNAPSHOT_DIR, `${modelName}.${dialect}.sql`)
        );
      });
    }
  }
});
