import assert from 'node:assert/strict';

export async function assertResourceRetry(browser, url) {
  for (const failure of ['http', 'network']) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      let failedPath;
      let attempts = 0;
      await page.route('**/api/integrations/*', async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        failedPath ??= pathname;
        if (pathname === failedPath && attempts++ === 0) {
          if (failure === 'http') await route.fulfill({ status: 503, body: '{}' });
          else await route.abort('failed');
        } else await route.continue();
      });
      await page.goto(`${url}/pipelines/new`);
      await page.getByRole('button', { name: /SaaS Analytics/ }).click();
      const retried = page.waitForResponse(
        (response) => new URL(response.url()).pathname === failedPath && response.status() === 200
      );
      await page.getByRole('button', { name: 'Next: Pick Resources', exact: true }).click();
      const recoveredAutomatically = await Promise.race([
        retried.then(() => true),
        page
          .getByText('Failed to load resources', { exact: true })
          .waitFor()
          .then(() => false)
          .catch(() => true),
      ]);
      if (!recoveredAutomatically) {
        await page.getByRole('button', { name: 'Back', exact: true }).click();
        await page.getByRole('button', { name: 'Next: Pick Resources', exact: true }).click();
        await retried;
      }
      assert.equal(attempts, 2, `${failure} failure must permit another resource fetch`);
      await page
        .getByText('Failed to load resources', { exact: true })
        .waitFor({ state: 'hidden' });
    } finally {
      await context.close();
    }
  }
}
