import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, copyFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { expect, it } from 'vitest';

const exec = promisify(execFile);
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(packageRoot, 'bin/cli.mjs');

it('walks a fresh retail project through the CLI and local API without paid calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retail-walkthrough-'));
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const env = {
    ...process.env,
    BOBSLED_CORE_OUTPUT_FORMAT: 'json',
    RETAIL_DEMO_API_TOKEN: 'local-retail-demo-token',
    BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS: '1',
    NODE_EXTRA_CA_CERTS: join(root, '.local/cert.pem'),
  };
  const run = async (...args: string[]) => {
    try {
      return (
        await exec(process.execPath, [cli, ...args], {
          cwd: root,
          env,
          timeout: 45000,
          maxBuffer: 4 * 1024 * 1024,
        })
      ).stdout;
    } catch (error) {
      const e = error as { stderr?: string; stdout?: string };
      throw new Error(`CLI ${args.join(' ')} failed: ${e.stderr || e.stdout || 'no output'}`);
    }
  };
  let api: ReturnType<typeof spawn> | undefined;
  try {
    await run('examples', 'init', 'retail', '--dir', root);
    await mkdir(join(root, '.local'));
    await exec(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(root, '.local/key.pem'),
        '-out',
        join(root, '.local/cert.pem'),
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=IP:127.0.0.1,DNS:localhost',
      ],
      { timeout: 10000 }
    );
    const integration = join(root, 'integrations/retail_api.yml');
    await writeFile(
      integration,
      (await readFile(integration, 'utf8')).replace(':8787', `:${port}`)
    );
    api = spawn(process.execPath, ['server.mjs'], {
      cwd: root,
      env: {
        ...env,
        RETAIL_DEMO_API_PORT: String(port),
        RETAIL_DEMO_TLS_CERT: join(root, '.local/cert.pem'),
        RETAIL_DEMO_TLS_KEY: join(root, '.local/key.pem'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('API did not start')), 10000);
      api!.stderr!.once('data', () => {
        clearTimeout(timer);
        resolve();
      });
      api!.once('error', reject);
    });
    await run('onboarding', 'verify', 'connect');
    await run(
      'pipeline',
      '--integration',
      'local_files',
      '--dest',
      'duckdb',
      '--db-path',
      'data.duckdb'
    );
    await run('onboarding', 'verify', 'load');
    const reference = join(packageRoot, 'examples/retail/reference');
    await mkdir(join(root, 'models'));
    for (const file of await readdir(join(reference, 'models'))) {
      await copyFile(
        join(reference, 'models', file),
        join(root, 'models', file.replace(/\.txt$/, ''))
      );
    }
    await run('model', 'validate', '--integration', 'warehouse');
    await run('model', 'run', '+product_performance', '--integration', 'warehouse');
    await run('onboarding', 'verify', 'model');
    const salesPath = join(root, 'models/product_sales_summary.yml');
    const correctSales = await readFile(salesPath, 'utf8');
    await writeFile(salesPath, correctSales.replace(/^where:.*\n/m, ''));
    await run('model', 'run', '+product_performance', '--integration', 'warehouse');
    await expect(run('onboarding', 'verify', 'model')).rejects.toThrow(
      /does not match its sources/
    );
    await writeFile(salesPath, correctSales);
    await run('model', 'run', '+product_performance', '--integration', 'warehouse');
    await run('onboarding', 'verify', 'model');
    await run('onboarding', 'verify', 'query');
    await run(
      'pipeline',
      '--integration',
      'retail_api',
      '--dest',
      'duckdb',
      '--db-path',
      'data.duckdb'
    );
    await run('model', 'run', 'product_review_summary', '--integration', 'warehouse');
    await run('model', 'run', 'prepared_support_cases', '--integration', 'warehouse');
    const { getTutorial } = await import('../../src/runtime/onboarding/tutorials.js');
    for (const query of getTutorial('retail').prepareCheck('federate', {}).queries) {
      if (query.remote === false) await run('query', query.sql, '--db-path', 'data.duckdb');
      else await run('--json', 'source-query', query.sql);
    }
    await run('onboarding', 'verify', 'federate');
    await run(
      'query',
      "UPDATE prepared_support_cases SET product_id = 'lmp-009' WHERE product_id IS NULL",
      '--db-path',
      'data.duckdb'
    );
    await expect(run('onboarding', 'verify', 'federate')).rejects.toThrow(
      /ambiguous support product identities/
    );
    await run('model', 'run', 'prepared_support_cases', '--integration', 'warehouse');
    await run('onboarding', 'verify', 'federate');
    const batch = join(root, 'models/support_batch.yml');
    await writeFile(
      batch,
      (await readFile(batch, 'utf8')).replace(
        "('case-0001')",
        "('case-0001', 'case-0011', 'case-0031')"
      )
    );
    await run('model', 'run', 'support_batch', '--integration', 'warehouse');
    await copyFile(join(reference, 'fixture-executor.mjs.txt'), join(root, 'fixture-executor.mjs'));
    // The fixture path needs a role shape, but must never contact a provider.
    await writeFile(
      join(root, 'dogsled.yml'),
      'pipelines: {}\nplatform:\n  models:\n    review:\n      provider: openai\n      model: example-model\n      api_key: $RETAIL_TEST_UNUSED_KEY\n      auth_env_vars: [RETAIL_TEST_UNUSED_KEY]\n'
    );
    await run(
      'model',
      'run',
      'support_case_classifications',
      '--integration',
      'warehouse',
      '--agent-executor',
      './fixture-executor.mjs',
      '--agent-run-id',
      'retail-offline',
      '--agent-tokens-per-assignment',
      '16384'
    );
    await expect(run('onboarding', 'verify', 'transform')).rejects.toThrow(/real model output/);
    const status = JSON.parse(await run('--json', 'onboarding', 'status'));
    expect(
      status.steps.filter((step: { status: string }) => step.status === 'complete')
    ).toHaveLength(5);
    const result = await run(
      'query',
      "SELECT ticket_id, product_id, analysis_mode FROM support_case_classifications WHERE ticket_id = 'case-0031'",
      '--db-path',
      'data.duckdb'
    );
    expect(result).toContain('fixture');
    expect(result).toContain('null');
    await run('onboarding', 'render');
    const html = await readFile(join(root, '.dogsled/onboarding/index.html'), 'utf8');
    const artifacts = join(packageRoot, 'test-results/retail-tutorial');
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, 'index.html'), html);
    expect(html).toContain('Products to investigate');
    expect(html).not.toMatch(/TV Night|TVmaze|Wikipedia/);
  } finally {
    if (api && api.exitCode === null) {
      api.kill('SIGTERM');
      await new Promise<void>((resolve) => api!.once('exit', () => resolve()));
    }
    await rm(root, { recursive: true, force: true });
  }
}, 180000);

it('checks classified product identity against raw order lines, even when batch preparation guessed', async () => {
  const { buildDuckDbRunner } = await import('@bobsled-inc/connections');
  const { copyExample } = await import('../../src/commands/examples.js');
  const { verifyOnboarding } = await import('../../src/runtime/onboarding/verify.js');
  const root = await mkdtemp(join(tmpdir(), 'retail-identity-'));
  copyExample('retail', root);
  const runner = await buildDuckDbRunner({
    spec_version: '1',
    type: 'integration',
    name: 'warehouse',
    source_type: 'duckdb',
    connection: { schema: 'main' },
    auth: { type: 'file', path: join(root, 'data.duckdb') },
  });
  try {
    await runner.run(`CREATE TABLE support_tickets AS SELECT 'case-0001' AS ticket_id, 'order-1' AS order_id, NULL::VARCHAR AS order_line_id, 'Which item?' AS message, 'Please identify it.' AS agent_reply;
      CREATE TABLE sales_order_lines AS SELECT 'order-1' AS order_id, 'line-1' AS order_line_id, 'product-a' AS product_id UNION ALL SELECT 'order-1','line-2','product-b';
      CREATE TABLE support_batch AS SELECT ticket_id, 'product-a' AS product_id, message || ' Agent response: ' || agent_reply AS conversation FROM support_tickets;
      CREATE TABLE support_case_classifications AS SELECT ticket_id, product_id, 'model' AS analysis_mode, 'other' AS issue_category, 'awaiting_customer' AS resolution_type, 'The item is unclear.' AS evidence_summary, 'Which item?' AS support_quote FROM support_batch;`);
    const read = async (_root: string, sql: string) => ({ rows: await runner.query(sql) });
    await expect(verifyOnboarding(root, 'transform', read)).rejects.toThrow(
      /preserve product identity/
    );
    await runner.run(
      'UPDATE support_batch SET product_id = NULL; UPDATE support_case_classifications SET product_id = NULL'
    );
    expect(
      (await verifyOnboarding(root, 'transform', read)).tables[0]?.rows[0]?.product_id
    ).toBeNull();
  } finally {
    await runner.close?.();
    await rm(root, { recursive: true, force: true });
  }
});
