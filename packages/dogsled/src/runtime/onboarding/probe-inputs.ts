import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { inputFiles, readBounded } from './files.js';

/** Match the source queried by verify connect, including its API and cache connection. */
export async function probeInputHash(root: string): Promise<string> {
  const records: { path: string; text: string; value: Record<string, unknown> }[] = [];
  const hash = createHash('sha256').update('tvmaze-probe-v1');
  let bytes = 0;
  for (const path of await inputFiles(root)) {
    if (
      !/^(sources|integrations|resources)\/.*\.ya?ml$/.test(path) &&
      path !== '.dogsled/config.yml'
    ) {
      continue;
    }
    const text = await readBounded(root, path);
    bytes += Buffer.byteLength(text);
    if (bytes > 20 * 1024 * 1024) throw new Error('Sample exceeds 20 MiB');
    const parsed: unknown = YAML.parse(text, { maxAliasCount: 0 });
    const value =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    records.push({ path, text, value });
  }
  const sources = records.filter(
    (r) => r.path.startsWith('sources/') && r.value['name'] === 'tvmaze_probe'
  );
  const needed = records.filter(
    (r) =>
      r.path === '.dogsled/config.yml' ||
      sources.includes(r) ||
      sources.some(
        ({ value: source }) =>
          (r.path.startsWith('integrations/') &&
            [source['integration'], source['connection']].includes(r.value['name'])) ||
          (r.path.startsWith('resources/') &&
            r.value['name'] === source['resource'] &&
            r.value['integration'] === source['integration'])
      )
  );
  for (const record of needed) {
    hash.update(record.path).update('\0').update(record.text).update('\0');
  }
  return hash.digest('hex');
}
