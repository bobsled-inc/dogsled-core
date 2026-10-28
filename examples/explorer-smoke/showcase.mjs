import assert from 'node:assert/strict';
import { assertResourceRetry } from './retry.mjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { publicApi, root } from '../../scripts/e2e/harness.mjs';
export const id = 'S17';
export async function run(ctx) {
  const { chromium } = await import('playwright');
  const { parse } = await import('yaml');
  const workspace = path.join(root, 'workspace/entity-graph-demo');
  await ctx.cli(
    ['model', 'seed', 'load', '--dialect', 'duckdb', '--runner', './runner.duckdb.js'],
    { cwd: workspace }
  );
  for (const phase of ['run', 'cluster', 'profile'])
    await ctx.cli(['entity-graph', 'resolve', phase, 'company', '--runner', './runner.duckdb.js'], {
      cwd: workspace,
    });
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const app = path.join(root, 'apps/explorer');
  const env = {
    ...ctx.env,
    PATH: `${path.join(app, 'node_modules/.bin')}${path.delimiter}${ctx.env.PATH}`,
    NEXT_TELEMETRY_DISABLED: '1',
  };
  const server = spawn(process.execPath, ['scripts/next-dev.mjs', '--port', String(port)], {
    cwd: app,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  server.stdout.on('data', (chunk) => {
    logs = (logs + chunk).slice(-2_000_000);
  });
  server.stderr.on('data', (chunk) => {
    logs = (logs + chunk).slice(-2_000_000);
  });
  let startupError;
  server.on('error', (error) => {
    startupError = error;
  });
  const artifacts = path.join(root, 'test-results/e2e/explorer');
  await mkdir(artifacts, { recursive: true });
  let browser;
  try {
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 90_000;
    while (true) {
      if (startupError) throw startupError;
      if (server.exitCode !== null) throw new Error(`Explorer exited before readiness: ${logs}`);
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (response.ok) break;
      } catch {}
      if (Date.now() > deadline) throw new Error(`Explorer startup timed out: ${logs}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    browser = await chromium.launch();
    const context = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    for (const [route, heading] of [
      ['/', null],
      ['/entity-graph', 'Entity Graph'],
      ['/integrations', 'Integrations'],
      ['/learn', 'Learn'],
    ]) {
      const response = await page.goto(url + route, { waitUntil: 'domcontentloaded' });
      assert.equal(response.status(), 200);
      if (heading) await page.getByRole('heading', { name: heading, exact: true }).waitFor();
      const text = await page.locator('body').innerText();
      assert.doesNotMatch(text, /\b(?:Track|Bobsled)\b/);
      if (route === '/integrations') {
        await page.locator('a[href^="/integrations/"]').nth(9).waitFor();
        assert.ok((await page.locator('a[href^="/integrations/"]').count()) >= 10);
      }
      if (route === '/learn') assert.ok((await page.locator('a[href^="/learn/"]').count()) >= 5);
      if (route === '/entity-graph') assert.doesNotMatch(text, /demo workspace not found/);
      await page.screenshot({
        path: path.join(artifacts, `${route.replaceAll('/', '') || 'home'}.png`),
        fullPage: true,
      });
    }
    await page.goto(`${url}/pipelines/new`);
    await page.getByRole('button', { name: /SaaS Analytics/ }).click();
    await page.getByRole('button', { name: 'Next: Pick Resources', exact: true }).click();
    await page.getByRole('button', { name: 'Select all', exact: true }).first().waitFor();
    while (await page.getByRole('button', { name: 'Select all', exact: true }).count())
      await page.getByRole('button', { name: 'Select all', exact: true }).first().click();
    await page.getByRole('button', { name: 'Next: Destination', exact: true }).click();
    await page.getByRole('button', { name: 'Next: Schedule', exact: true }).click();
    await page.getByRole('button', { name: 'Review', exact: true }).last().click();
    await page.getByRole('link', { name: 'Export Options', exact: true }).click();
    await page.getByRole('button', { name: 'Copy to clipboard', exact: true }).click();
    await page.getByRole('button', { name: 'Copied!', exact: true }).waitFor({ state: 'visible' });
    const yaml = await page.evaluate(() => navigator.clipboard.readText());
    const exported = parse(yaml);
    const { DogsledConfigSchema } = await publicApi('manifest');
    const checked = DogsledConfigSchema.safeParse(exported);
    assert.equal(checked.success, true, checked.error?.message);
    assert.ok(Object.keys(exported.pipelines).length >= 1);
    await writeFile(path.join(artifacts, 'exported.dogsled.yml'), yaml);
    await page.screenshot({ path: path.join(artifacts, 'pipeline-export.png'), fullPage: true });
    assert.deepEqual(errors, []);
    await assertResourceRetry(browser, url);
  } finally {
    await browser?.close();
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {}
    await writeFile(path.join(artifacts, 'server.log'), logs);
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      process.kill(-server.pid, 'SIGKILL');
    } catch {}
  }
}
