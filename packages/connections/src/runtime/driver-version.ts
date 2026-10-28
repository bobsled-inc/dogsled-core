import { readFileSync } from 'node:fs';
import path from 'node:path';

export function assertDriverVersion(
  name: string,
  minimum: string,
  require: { resolve(specifier: string): string },
  specifier = name
): void {
  const required = `${name} >= ${minimum} required`;
  let directory = path.dirname(require.resolve(specifier));
  let version: unknown;
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
      if (manifest.name === name) {
        version = manifest.version;
        break;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`${required}; unable to verify installed version.`);
    directory = parent;
  }
  const stable =
    typeof version === 'string' &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[\w.-]+)?$/.test(version);
  const actual = stable ? (version as string).split('+')[0]!.split('.').map(Number) : [];
  const floor = minimum.split('.').map(Number);
  const difference = actual
    .map((value, index) => value - floor[index]!)
    .find((value) => value !== 0);
  if (!stable || (difference ?? 0) < 0) {
    throw new Error(`${required}; installed ${String(version)}. Upgrade the driver before use.`);
  }
}
