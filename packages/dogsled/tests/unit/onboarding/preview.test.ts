import { afterEach, expect, it } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { previewScenarios } from '../../../scripts/onboarding-preview-fixtures.js';
import { reviewPage } from '../../../scripts/onboarding-preview-page.js';
import { renderOnboardingHtml } from '../../../src/runtime/onboarding/render.js';
import { Snapshot } from '../../../src/runtime/onboarding/schema.js';

const windows: JSDOM[] = [];
afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close();
});
it('renders all synthetic review states through the canonical snapshot contract', () => {
  const scenarios = previewScenarios();
  expect(scenarios.map((s) => s.id)).toEqual([
    'start',
    'populated',
    'empty',
    'reviewed',
    'failed',
    'attention',
    'long',
    'graph',
  ]);
  for (const scenario of scenarios) {
    expect(Snapshot.safeParse(scenario.snapshot).success).toBe(true);
    const html = renderOnboardingHtml(scenario.snapshot);
    expect(html).toContain('id="chapters-toggle"');
    expect(html).not.toContain('id="review-width"');
    expect(html).not.toContain('contains a cycle');
  }
  expect(scenarios.find((s) => s.id === 'start')!.snapshot.tables).toEqual([]);
  expect(
    scenarios
      .find((s) => s.id === 'failed')!
      .snapshot.state.steps.some((s) => s.status === 'failed')
  ).toBe(true);
  expect(scenarios.find((s) => s.id === 'graph')!.snapshot.lineage!.nodes).toHaveLength(40);
});
it('switches scenario, theme and iframe width using only known local review pages', () => {
  const errors: Error[] = [];
  const console = new VirtualConsole();
  console.on('jsdomError', (e: Error) => errors.push(e));
  const dom = new JSDOM(reviewPage(previewScenarios()), {
    url: 'https://example.com/review/index.html#state=populated&theme=light&width=fit',
    runScripts: 'dangerously',
    virtualConsole: console,
  });
  windows.push(dom);
  const document = dom.window.document;
  const choose = (id: string, value: string) => {
    const select = document.getElementById(id) as HTMLSelectElement;
    select.value = value;
    select.dispatchEvent(new dom.window.Event('change'));
  };
  choose('scenario', 'failed');
  choose('review-theme', 'dark');
  choose('review-width', '390');
  const frame = document.getElementById('preview-frame') as HTMLIFrameElement;
  expect(frame.getAttribute('src')).toBe('failed-dark.html#federate');
  expect(frame.style.width).toBe('390px');
  expect(document.getElementById('open-preview')?.getAttribute('href')).toBe(
    'failed-dark.html#federate'
  );
  expect(dom.window.location.hash).toContain('state=failed');
  choose('review-width', 'fit');
  expect(frame.style.width).toBe('100%');
  expect(errors).toEqual([]);
});
it('builds a portable review folder without services or a design workspace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tv-review-'));
  try {
    execFileSync(
      process.execPath,
      ['--import', 'tsx', resolve('scripts/onboarding-preview.ts'), directory],
      { stdio: 'pipe' }
    );
    expect(await readdir(directory)).toHaveLength(25);
    expect(await readFile(join(directory, 'index.html'), 'utf8')).toContain(
      'TV Night · Visual review'
    );
    const dark = await readFile(join(directory, 'populated-dark.html'), 'utf8');
    expect(dark).toContain('<html lang="en" data-theme="dark">');
    expect(dark).toContain('<option value="dark" selected>');
    expect(dark).toContain('Synthetic visual-review fixture');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
