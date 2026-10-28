import { pathToFileURL } from 'node:url';

import { renderCatalogManifestJson } from '../src/catalog/manifest.js';

async function main(): Promise<void> {
  process.stdout.write(renderCatalogManifestJson());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
