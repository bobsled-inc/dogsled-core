import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const datasets = new Map([
  ['/reviews', resolve(root, 'data/retail/api/reviews.json')],
  ['/support-tickets', resolve(root, 'data/retail/api/support-tickets.json')],
]);
const token = process.env.RETAIL_DEMO_API_TOKEN || 'local-retail-demo-token';
const port = Number(process.env.RETAIL_DEMO_API_PORT || 8787);
const certPath = process.env.RETAIL_DEMO_TLS_CERT;
const keyPath = process.env.RETAIL_DEMO_TLS_KEY;
if (!certPath || !keyPath)
  throw new Error(
    'Set RETAIL_DEMO_TLS_CERT and RETAIL_DEMO_TLS_KEY to local development certificate paths'
  );
const server = createServer(
  { cert: await readFile(certPath), key: await readFile(keyPath) },
  async (req, res) => {
    const url = new URL(req.url || '/', `https://127.0.0.1:${port}`);
    const file = datasets.get(url.pathname);
    if (!file) return send(res, 404, { error: 'not_found' });
    if (req.headers.authorization !== `Bearer ${token}`)
      return send(res, 401, { error: 'unauthorized' });
    const records = JSON.parse(await readFile(file, 'utf8'));
    const pageSize = Number(url.searchParams.get('page_size') || '17');
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100)
      return send(res, 400, { error: 'invalid_page_size' });
    const offset = Number(url.searchParams.get('cursor') || '0');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > records.length)
      return send(res, 400, { error: 'invalid_cursor' });
    const filtered = url.searchParams.has('product_id')
      ? records.filter((record) => record.product_id === url.searchParams.get('product_id'))
      : records;
    const data = filtered.slice(offset, offset + pageSize);
    const next = offset + pageSize < filtered.length ? String(offset + pageSize) : null;
    return send(res, 200, { data, meta: { next_cursor: next, page_size: pageSize } });
  }
);
function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
server.listen(port, '127.0.0.1', () =>
  process.stderr.write(`Retail demo API listening on https://127.0.0.1:${port}`)
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => server.close(() => (process.exitCode = 0)));
