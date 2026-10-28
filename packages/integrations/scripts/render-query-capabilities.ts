import { pathToFileURL } from 'node:url';

import { renderQueryCapabilitiesManifestJson } from '../src/query-resources/capabilities-manifest.js';

async function main(): Promise<void> {
  process.stdout.write(renderQueryCapabilitiesManifestJson());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
