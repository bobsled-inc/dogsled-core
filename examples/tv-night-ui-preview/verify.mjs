import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ownFile = fileURLToPath(import.meta.url);
const digest = (value) => createHash('sha256').update(value).digest('hex');

export async function verifyPreview(root = dirname(ownFile)) {
  const html = await readFile(join(root, 'index.html'), 'utf8');
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  assert.equal(
    Buffer.byteLength(html),
    manifest.htmlBytes,
    'Generated HTML size changed; rebuild the preview.'
  );
  const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  const data = scripts.find(([, attributes]) => attributes.includes('application/json'));
  const runtime = scripts.find(([, attributes]) => !attributes.includes('application/json'))?.[2];
  assert(
    css && data && runtime,
    'The standalone preview must embed styles, snapshot, and runtime.'
  );
  assert.equal(scripts.length, 2);
  assert.equal(digest(css), manifest.assets.css.sha256, 'CSS digest changed; rebuild the preview.');
  assert.equal(
    digest(runtime),
    manifest.assets.javascript.sha256,
    'Runtime digest changed; rebuild the preview.'
  );
  assert.equal(manifest.externalRuntimeResources, 0);
  assert(html.includes("connect-src 'none'"));
  assert(!/<script[^>]+src=|<link[^>]+href=|<img[^>]+src=(?!["']?data:)/i.test(html));
  assert.equal((html.match(/@font-face/g) ?? []).length, 2);
  const snapshot = JSON.parse(data[2]);
  assert.deepEqual(
    snapshot,
    JSON.parse(await readFile(join(root, 'fixtures/snapshot.json'), 'utf8'))
  );
  assert.equal(snapshot.state.datasetVersion, 'DUMMY FIXTURE v1');
  const catalog = JSON.parse(await readFile(join(root, 'fixtures/catalog.json'), 'utf8'));
  const shows = catalog.shows.length;
  const episodes = catalog.shows.reduce((total, show) => total + show.episodes.length, 0);
  assert.equal(snapshot.tables.find((table) => table.name === 'Shows').totalRows, shows);
  assert.equal(snapshot.tables.find((table) => table.name === 'Episodes').totalRows, episodes);
  for (const path of [
    ...manifest.licenseFiles,
    'comparisons/workspace.html',
    'comparisons/original.html',
  ]) {
    await access(join(root, path));
  }
  assert(runtime.includes('./comparisons/workspace.html'));
  assert(runtime.includes('./comparisons/original.html'));
  return { shows, episodes, externalRuntimeResources: 0 };
}

if (process.argv[1] && resolve(process.argv[1]) === ownFile) {
  const result = await verifyPreview();
  process.stdout.write(
    `Verified standalone preview: ${result.shows} fictional shows, ${result.episodes} episodes, no external runtime resources.\n`
  );
}
