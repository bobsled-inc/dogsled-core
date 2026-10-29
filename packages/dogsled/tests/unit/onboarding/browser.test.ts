import { afterEach, expect, it, vi } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import { renderOnboardingHtml } from '../../../src/runtime/onboarding/render.js';
import { renderFixture } from './render-fixture.js';

const windows: JSDOM[] = [];
afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close();
});
function open(snapshot = renderFixture(), clipboard = true, hash = '') {
  const errors: Error[] = [];
  const copied: string[] = [];
  const console = new VirtualConsole();
  console.on('jsdomError', (error: Error) => errors.push(error));
  const dom = new JSDOM(renderOnboardingHtml(snapshot), {
    url: `https://example.com/tutorial${hash}`,
    runScripts: 'dangerously',
    virtualConsole: console,
    beforeParse(window) {
      window.scrollTo = vi.fn();
      window.HTMLElement.prototype.scrollIntoView = vi.fn();
      if (clipboard) {
        Object.defineProperty(window.navigator, 'clipboard', {
          value: {
            writeText: async (text: string) => {
              copied.push(text);
            },
          },
        });
      }
    },
  });
  windows.push(dom);
  expect(errors.map((error) => error.message)).toEqual([]);
  const document = dom.window.document;
  const click = (selector: string) => {
    const button = document.querySelector(selector);
    expect(button, selector).toBeTruthy();
    (button as HTMLElement).click();
  };
  return { dom, document, click, copied };
}
it('browses chapters without completing or reviewing them and retains deep links', () => {
  const { document, click } = open();
  expect(document.querySelector('[aria-current="step"]')?.getAttribute('href')).toBe('#load');
  click('#next-chapter');
  expect(document.querySelector('#model')?.hasAttribute('hidden')).toBe(false);
  expect((document.querySelector('#review-chapter') as HTMLButtonElement).disabled).toBe(true);
  expect(document.querySelectorAll('[data-reviewed="true"]')).toHaveLength(0);
  expect(document.querySelector('#model #workspace')).toBeTruthy();
  click('[data-return-current]');
  expect(document.querySelector('#load #workspace')).toBeTruthy();
  const linked = open(renderFixture(), true, '#ready-model');
  expect(linked.document.querySelector('[aria-current="step"]')?.getAttribute('href')).toBe(
    '#model'
  );
});
it('searches every column, pages saved previews, resets tabs and supports keyboard switching', () => {
  const { document, click, dom } = open();
  const root = '[data-results="load"]';
  expect(document.querySelectorAll(`${root} [data-result-panel="0"] tbody tr`)).toHaveLength(20);
  click(`${root} [data-page="next"]`);
  expect(document.querySelectorAll(`${root} [data-result-panel="0"] tbody tr`)).toHaveLength(5);
  click(`${root} [data-search-toggle]`);
  const search = document.querySelector(`${root} input`) as HTMLInputElement;
  search.value = 'Passage 25';
  search.dispatchEvent(new dom.window.Event('input'));
  expect(document.querySelectorAll(`${root} [data-result-panel="0"] tbody tr`)).toHaveLength(1);
  expect(document.querySelector(`${root} [data-row-count]`)?.textContent).toBe('1/200');
  click(`${root} [data-result-tab="1"]`);
  expect(search.value).toBe('');
  expect(document.querySelector(`${root} [data-row-count]`)?.textContent).toBe('1/1');
  document
    .querySelector(`${root} [data-result-tab="1"]`)
    ?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  expect(
    document.querySelector(`${root} [data-result-tab="0"]`)?.getAttribute('aria-selected')
  ).toBe('true');
  expect(document.activeElement).toBe(document.querySelector(`${root} [data-result-tab="0"]`));
});
it('sorts numbers and inspects records safely, keeping spoiler text collapsed', () => {
  const snapshot = renderFixture();
  snapshot.state.steps[1]!.evidence!.tables[0]!.rows[0]!.name = '<img src=x onerror=alert(1)>';
  const { document, click, dom } = open(snapshot);
  const root = '[data-results="load"]';
  click(`${root} [data-sort="id"]`);
  click(`${root} [data-sort="id"]`);
  expect(document.querySelector(`${root} tbody td`)?.textContent).toBe('25');
  click(`${root} tbody button`);
  expect(document.querySelector('#load [data-record-title]')?.textContent).toBe('Series 25');
  expect(document.querySelector('#load [data-record-fields] details')?.hasAttribute('open')).toBe(
    false
  );
  document
    .querySelector('#load [data-record]')
    ?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(document.querySelector('#load [data-record]')?.hasAttribute('hidden')).toBe(true);
  expect(document.querySelectorAll('img')).toHaveLength(1); // bundled logo only
  click('[data-file="sources/shows.yml"]');
  expect(document.querySelector('#file-content')?.textContent).toContain('<script>inert</script>');
  expect(document.querySelector('#file-content script')).toBeNull();
});
it('copies a guarded review request without inventing journal progress', async () => {
  const { document, click, copied } = open();
  click('#review-chapter');
  await Promise.resolve();
  expect(copied[0]).toMatch(/dogsled onboarding review load --checkpoint [a-f0-9]{64}/);
  expect(copied[0]).toContain('dogsled onboarding render');
  expect(document.querySelector('#load')?.getAttribute('data-reviewed')).toBe('false');
  expect(document.querySelector('#review-chapter')?.textContent).toBe('Mark as reviewed');
  const snapshot = renderFixture();
  snapshot.progress!.reviewed = ['load'];
  const refreshed = open(snapshot);
  expect(refreshed.document.querySelector('#review-chapter')?.textContent).toBe('Reviewed');
  expect((refreshed.document.querySelector('#review-chapter') as HTMLButtonElement).disabled).toBe(
    true
  );
});
it('selects the exact request for manual copy when the clipboard is unavailable', async () => {
  const { document, dom, click } = open(renderFixture(), false);
  click('#load [data-copy-target]');
  await Promise.resolve();
  expect(dom.window.getSelection()?.toString()).toBe(
    document.querySelector('#request-load')?.textContent
  );
  expect(document.querySelector('#copy-status')?.textContent).toContain('copy it manually');
});
it('handles empty and failed evidence and exposes the theme in More', () => {
  const snapshot = renderFixture();
  snapshot.tables = [];
  snapshot.state.steps[1]!.status = 'failed';
  delete snapshot.state.steps[1]!.evidence;
  const { document, click, dom } = open(snapshot);
  expect(document.querySelector('#load .empty-state h3')?.textContent).toBe('No results yet');
  expect(document.querySelector('#load .badge')?.textContent).toBe('Check failed');
  expect((document.querySelector('#review-chapter') as HTMLButtonElement).disabled).toBe(true);
  click('[data-context]');
  expect((document.querySelector('#question') as HTMLDetailsElement).open).toBe(true);
  const theme = document.querySelector('#theme') as HTMLSelectElement;
  theme.value = 'dark';
  theme.dispatchEvent(new dom.window.Event('change'));
  expect(document.documentElement.dataset.theme).toBe('dark');
});

it('keeps untrusted snapshot text inert after interaction and supports legacy panel links', () => {
  const snapshot = renderFixture();
  const payload =
    '</script><script>window.injected=true</script><img src=x onerror="window.injected=true">';
  snapshot.question = payload;
  snapshot.state.steps[1]!.evidence!.tables[0]!.rows[0]!.name = payload;
  snapshot.state.steps[1]!.evidence!.tables[0]!.columns.push(payload);
  const { dom, document, click } = open(snapshot, true, '#data');
  expect((document.querySelector('#question') as HTMLDetailsElement).open).toBe(true);
  expect((document.querySelector('#data') as HTMLDetailsElement).open).toBe(true);
  click('[data-results="load"] tbody button');
  expect(document.querySelectorAll('img')).toHaveLength(1);
  expect((dom.window as unknown as Record<string, unknown>).injected).toBeUndefined();
});

it('keeps canonical brand paint and current chapter icons aligned during navigation', () => {
  const snapshot = renderFixture();
  snapshot.progress!.reviewed = ['connect'];
  const { document, dom, click } = open(snapshot);
  expect(document.querySelectorAll('#dogsled-gradient-brand')).toHaveLength(1);
  expect(document.querySelector('#dogsled-gradient-brand')?.getAttribute('gradientTransform')).toBe(
    'rotate(210, 0.5, 0.5)'
  );
  const currentIcon = document.querySelector('[data-chapter-link="load"] .current-icon')!;
  const reviewedIcon = document.querySelector('[data-chapter-link="connect"] .status-icon')!;
  expect(dom.window.getComputedStyle(currentIcon).display).toBe('inline-block');
  expect(dom.window.getComputedStyle(currentIcon.querySelector('path')!).fill).toBe(
    'url(#dogsled-gradient-brand)'
  );
  expect(dom.window.getComputedStyle(reviewedIcon).display).not.toBe('none');
  expect(
    dom.window.getComputedStyle(document.documentElement).getPropertyValue('--icon-positive').trim()
  ).toBe('#449b7c');
  click('#next-chapter');
  expect(dom.window.getComputedStyle(currentIcon).display).toBe('none');
  expect(
    dom.window.getComputedStyle(
      document.querySelector('[data-chapter-link="model"] .current-icon')!
    ).display
  ).toBe('inline-block');
});

it('gives result columns room inside their own scrolling region', () => {
  const { document, dom } = open();
  const table = document.querySelector('[data-results="load"] table') as HTMLTableElement;
  const columns = Array.from(table.querySelectorAll('col'));
  const widths = columns.map((column) => Number.parseInt((column as HTMLElement).style.width));
  expect(widths[1]).toBeGreaterThanOrEqual(240);
  expect(widths.at(-1)).toBeGreaterThanOrEqual(96);
  expect(Number.parseInt(table.style.minWidth)).toBeGreaterThan(1000);
  expect(dom.window.getComputedStyle(table.parentElement!).overflow).toBe('auto');
  expect(dom.window.getComputedStyle(table.querySelector('.details-column')!).whiteSpace).toBe(
    'nowrap'
  );
  expect(dom.window.getComputedStyle(table.querySelector('td')!).whiteSpace).toBe('nowrap');
});
