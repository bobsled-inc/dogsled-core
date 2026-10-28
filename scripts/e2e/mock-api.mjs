import { context } from './harness.mjs';
import { mockApi } from './services.mjs';
import { showcaseData } from './mock-data.mjs';

const { datasets, advance } = showcaseData(process.argv[2]);
const ctx = await context('manual-api');
const api = await mockApi(ctx, datasets, { advance });
for (const key of [
  'SHOWCASE_API_URL',
  'SHOWCASE_API_AUTHORITY',
  'SHOWCASE_API_TOKEN',
  'NODE_EXTRA_CA_CERTS',
  'DOGSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS',
]) {
  const value = ctx.env[key].replaceAll("'", "'\\''");
  process.stdout.write(`export ${key}='${value}'\n`);
}
process.stdout.write(
  '# Copy these exports into your example terminal. Ctrl-C stops the local API.\n'
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await api.close();
  await ctx.cleanup();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
