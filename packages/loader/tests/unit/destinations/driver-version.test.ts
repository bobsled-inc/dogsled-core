import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ directory: '' }));
vi.mock('node:module', async (original) => {
  const actual = await original<typeof import('node:module')>();
  return {
    ...actual,
    createRequire: (url: string | URL) => {
      const require = actual.createRequire(url);
      return new Proxy(require, {
        get(target, key) {
          if (key === 'resolve') return () => path.join(state.directory, 'driver.cjs');
          return Reflect.get(target, key);
        },
      });
    },
  };
});
afterEach(() => {
  if (state.directory) rmSync(state.directory, { recursive: true, force: true });
});
function oldDriver(name: string, version: string) {
  state.directory = mkdtempSync(path.join(os.tmpdir(), 'dogsled-old-driver-'));
  writeFileSync(path.join(state.directory, 'package.json'), JSON.stringify({ name, version }));
}
describe('default destination driver loaders', () => {
  it('refuses a preinstalled vulnerable MySQL driver before importing or connecting', async () => {
    oldDriver('mysql2', '3.21.0');
    const { MySqlDestination } = await import('../../../src/runtime/destinations/mysql.js');
    const destination = new MySqlDestination({
      host: 'warehouse.example.com',
      database: 'data',
      user: 'test',
    });
    await expect(destination.initialize()).rejects.toMatchObject({
      message: 'mysql2 >= 3.22.0 required; installed 3.21.0. Upgrade the driver before use.',
    });
  });
  it('refuses a preinstalled Snowflake driver below the security floor', async () => {
    oldDriver('snowflake-sdk', '3.3.0');
    const { createSnowflakeSdkConnection } =
      await import('../../../src/runtime/destinations/snowflake-connection.js');
    expect(() =>
      createSnowflakeSdkConnection({ account: 'example', username: 'test' }, (error) =>
        error instanceof Error ? error : new Error(String(error))
      )
    ).toThrow(
      /^snowflake-sdk >= 3\.4\.0 required; installed 3\.3\.0\. Upgrade the driver before use\.$/
    );
  });
});
