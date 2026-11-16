import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertDriverVersion } from '../../../src/runtime/driver-version.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function installed(name: string, version: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bobsled-driver-version-'));
  roots.push(root);
  const dir = path.join(root, 'node_modules', name);
  mkdirSync(path.join(dir, 'dist'), { recursive: true });
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version, main: './dist/index.js', exports: './dist/index.js' })
  );
  writeFileSync(
    path.join(dir, 'dist/index.js'),
    'throw new Error("driver must not execute during version check")'
  );
  return createRequire(path.join(root, 'consumer.cjs'));
}
describe('installed optional driver security versions', () => {
  it.each([
    ['mysql2', '3.22.0', '3.21.9'],
    ['snowflake-sdk', '3.4.0', '3.3.0'],
    ['pg', '8.4.0', '8.3.3'],
    ['@databricks/sql', '2.0.0', '1.17.0'],
    ['@google-cloud/bigquery', '8.1.1', '7.0.0'],
    ['@aws-sdk/client-s3', '3.1017.0', '3.0.0'],
  ])('rejects old %s before evaluating its code', (name, floor, old) => {
    expect(() => assertDriverVersion(name, floor, installed(name, old))).toThrow(
      `${name} >= ${floor} required`
    );
    expect(() => assertDriverVersion(name, floor, installed(name, floor))).not.toThrow();
  });
  it.each(['3.22.0-beta.1', 'unknown', '3.2', '3.22.0junk'])('fails closed for %s', (version) => {
    expect(() => assertDriverVersion('mysql2', '3.22.0', installed('mysql2', version))).toThrow(
      'mysql2 >= 3.22.0 required'
    );
  });
  it('supports a newer major and build metadata without exported package.json', () => {
    expect(() =>
      assertDriverVersion('mysql2', '3.22.0', installed('mysql2', '4.0.0+build.1'))
    ).not.toThrow();
  });
});
