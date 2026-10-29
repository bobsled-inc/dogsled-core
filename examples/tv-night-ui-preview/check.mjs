import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const kitRoot = dirname(fileURLToPath(import.meta.url));
const demoRoot = kitRoot;
if (!process.env.DOGSLED_UI_ROOT)
  throw new Error('Set DOGSLED_UI_ROOT to a prepared UI workspace.');
const uiRepository = resolve(process.env.DOGSLED_UI_ROOT);
const uiRequire = createRequire(join(uiRepository, 'packages/ui/package.json'));
const { JSDOM, VirtualConsole } = uiRequire('jsdom');
const { configure, fireEvent, getByRole, queryByRole } = uiRequire('@testing-library/dom');
configure({ getElementError: (message) => new Error(message.split('\nHere are')[0]) });
const html = await readFile(join(demoRoot, 'index.html'), 'utf8');
const manifest = JSON.parse(await readFile(join(kitRoot, 'manifest.json'), 'utf8'));
const require = createRequire(import.meta.url);
const { renderArtifact, layoutLineage, chapterContent } = require(
  join(kitRoot, '.build/server.cjs')
);
const saved = JSON.parse(await readFile(join(demoRoot, 'fixtures/snapshot.json'), 'utf8'));
assert.deepEqual(
  chapterContent(saved, 'connect').snapshot.files.map((file) => file.path),
  ['integrations/dummy-catalog.yml']
);
assert.equal(chapterContent(saved, 'load').snapshot.files.length, 4);
assert.deepEqual(
  chapterContent(saved, 'model').snapshot.files.map((file) => file.path),
  ['sources/shows.yml', 'sources/episodes.yml']
);
assert.equal(chapterContent(saved, 'model').snapshot.lineage.edges.length, 0);
assert.equal(chapterContent(saved, 'transform').snapshot.files.length, 0);
assert.equal(chapterContent(saved, 'transform').snapshot.lineage.nodes.length, 0);
for (const chapter of saved.state.steps) {
  const content = chapterContent(saved, chapter.id);
  assert(content.lesson.outcome.length > 0 && content.inspectionTask.length > 0);
  assert(content.snapshot.files.every((file) => saved.files.includes(file)));
  const paths = new Set(content.snapshot.files.map((file) => file.path));
  assert(content.snapshot.lineage.nodes.every((node) => paths.has(node.id)));
}
const renamed = structuredClone(saved);
renamed.state.steps
  .find((chapter) => chapter.id === 'load')
  .evidence.tables.find((table) => table.name === 'Shows').rows[0].name = 'Changed fixture title';
assert(chapterContent(renamed, 'load').inspectionTask.includes('Changed fixture title'));
const empty = structuredClone(saved);
empty.state.steps = empty.state.steps.map(({ evidence, ...chapter }) => ({
  ...chapter,
  status: 'not_started',
}));
empty.progress = { current: 'connect', reviewed: [] };
empty.tables = [];
empty.files = [];
empty.lineage = { nodes: [], edges: [] };
assert(renderArtifact(empty).includes('No results yet'));
const failed = structuredClone(saved);
const failedLoad = failed.state.steps.find((chapter) => chapter.id === 'load');
failedLoad.status = 'failed';
failedLoad.evidence.tables = [];
assert(renderArtifact(failed).includes('Load failed'));
const graph = layoutLineage(saved.lineage);
assert(graph);
for (const position of graph.positions.values()) {
  assert(position.x >= 0 && position.y >= 0);
  assert(position.x + 240 <= graph.width && position.y + 132 <= graph.height);
}
assert.equal(
  layoutLineage({
    nodes: saved.lineage.nodes,
    edges: [{ from: 'missing', to: saved.lineage.nodes[0].id }],
  }),
  null
);
assert.equal(
  layoutLineage({
    nodes: saved.lineage.nodes,
    edges: [
      ...saved.lineage.edges,
      { from: saved.lineage.edges[0].to, to: saved.lineage.edges[0].from },
    ],
  }),
  null
);
assert.equal(manifest.externalRuntimeResources, 0);
assert.equal((html.match(/@font-face/g) ?? []).length, 2);
assert(!/<script[^>]+src=|<link[^>]+href=|<img[^>]+src=(?!["']?data:)/i.test(html));
assert(html.includes("connect-src 'none'"));
assert(manifest.imports.includes('@dogsled/ui/ResultsTable'));
assert(manifest.imports.includes('@dogsled/ui/Sidebar'));
assert(manifest.imports.includes('@dogsled/ui/GraphNode'));
assert(manifest.imports.includes('@dogsled/ui/EmptyState'));
assert(manifest.imports.includes('@dogsled/ui/icons/LoadingSpinnerHold'));
assert(!manifest.imports.includes('@dogsled/ui/Banner'));
assert(!manifest.imports.includes('@dogsled/ui/SidebarFooter'));
const graphInputs = JSON.parse(await readFile(join(kitRoot, '.build/client-meta.json'), 'utf8'));
assert(!Object.keys(graphInputs.inputs).some((path) => path.includes('@xyflow')));
const errors = [];
const copied = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (error) => errors.push(error.message));
virtualConsole.on('error', (...args) => errors.push(args.join(' ')));
const dom = new JSDOM(html.replace(/<style>[\s\S]*?<\/style>/, ''), {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole,
  beforeParse(window) {
    window.matchMedia = (query) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    });
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    window.HTMLElement.prototype.scrollIntoView = function () {};
    window.scrollTo = function () {};
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: async (text) => copied.push(text) },
      configurable: true,
    });
  },
});
const document = dom.window.document;
const settle = () => new Promise((resolve) => setTimeout(resolve, 35));
const click = async (element) => {
  fireEvent.pointerDown(element, { button: 0, pointerType: 'mouse' });
  fireEvent.mouseDown(element, { button: 0 });
  fireEvent.mouseUp(element, { button: 0 });
  fireEvent.click(element, { button: 0 });
  await settle();
};
try {
  await settle();
  assert.equal(
    getByRole(document.body, 'heading', { level: 1 }).textContent,
    'Build an ETL pipeline'
  );
  assert(document.querySelector('.workspace-header time').textContent.includes('Saved'));
  assert.equal(document.querySelector('.snapshot-caption'), null);
  assert.equal(document.querySelector('.artifact-footer'), null);
  assert.equal(document.querySelector('.summary-strip'), null);
  assert(
    document
      .querySelector('[aria-label="Chapter context"]')
      .textContent.includes('6 shows · 18 episodes')
  );
  assert(
    document.querySelector('.inspection-task').textContent.includes('Orbital Assembly (ID 1001)')
  );
  assert(
    [...document.querySelectorAll('.flow-section h2')].every((heading) =>
      heading.classList.contains('text-heading-md')
    )
  );
  const mark = document.querySelector('.journey-rail svg[data-icon-favicon] image');
  assert(mark?.getAttribute('href')?.startsWith('data:image/svg+xml;base64,'));
  assert.equal(
    Buffer.from(mark.getAttribute('href').split(',')[1], 'base64').length,
    manifest.brandAssets.find((asset) => asset.path.endsWith('dogsled-mark.svg')).bytes
  );
  assert(
    [...document.querySelectorAll('image')].every((image) =>
      image.getAttribute('href').startsWith('data:')
    )
  );
  assert.deepEqual(
    [...document.querySelectorAll('.flow-section h2')].map((heading) => heading.textContent),
    [
      'Understand what you built',
      'Inspect the saved result',
      'Connect the files to the result',
      'Ready to move on?',
    ]
  );
  assert(
    getByRole(document.body, 'navigation', { name: 'Tutorial chapters' }).textContent.includes(
      'Agentic transformation'
    )
  );
  assert.equal(document.querySelector('.journey-footer'), null);
  assert(!document.querySelector('.journey-rail').textContent.includes('Your progress'));
  const actions = getByRole(document.body, 'navigation', { name: 'Chapter actions' });
  assert(!actions.textContent.includes('2/6'));
  assert(getByRole(actions, 'button', { name: 'Previous' }));
  assert(getByRole(actions, 'button', { name: 'Next step' }));
  assert(!queryByRole(actions, 'button', { name: /Copy/ }));
  assert(!queryByRole(document.body, 'button', { name: 'Collapse chapter navigation' }));
  const tableTabs = getByRole(document.body, 'tablist', { name: 'Saved tables' });
  assert.equal(
    getByRole(tableTabs, 'tab', { name: 'Shows', exact: true }).getAttribute('aria-selected'),
    'true'
  );
  assert(getByRole(document.body, 'tabpanel', { name: 'Shows', exact: true }));
  assert(getByRole(document.body, 'table', { name: 'Shows records' }));
  assert.equal(document.querySelector('.row-count > span[aria-hidden="true"]').textContent, '6/6');
  assert(
    document
      .querySelector('.row-count')
      .compareDocumentPosition(getByRole(document.body, 'button', { name: 'Search Shows' })) &
      dom.window.Node.DOCUMENT_POSITION_FOLLOWING
  );
  const inspect = getByRole(document.body, 'button', { name: 'Inspect Orbital Assembly record' });
  assert.equal(inspect.textContent, '');
  assert(inspect.querySelector('svg'));
  await click(inspect);
  assert(
    getByRole(document.body, 'region', { name: 'Record inspection' }).textContent.includes(
      'Orbital Assembly'
    )
  );
  assert.equal(inspect.getAttribute('aria-expanded'), 'true');
  assert.equal(inspect.getAttribute('aria-controls'), 'record-inspection');
  const second = getByRole(document.body, 'button', { name: 'Inspect The Last Signal record' });
  await click(second);
  assert.equal(inspect.getAttribute('aria-expanded'), 'false');
  assert.equal(second.getAttribute('aria-expanded'), 'true');
  assert(
    getByRole(document.body, 'region', { name: 'Record inspection' }).textContent.includes(
      'The Last Signal'
    )
  );
  await click(second);
  assert(!queryByRole(document.body, 'region', { name: 'Record inspection' }));
  await click(inspect);
  const close = getByRole(document.body, 'button', { name: 'Close record inspection' });
  assert.equal(close.textContent, '');
  await click(close);
  assert.equal(inspect.getAttribute('aria-expanded'), 'false');
  assert(!queryByRole(document.body, 'region', { name: 'Record inspection' }));
  await click(getByRole(document.body, 'button', { name: 'Search Shows' }));
  const search = getByRole(document.body, 'textbox', { name: 'Search Shows' });
  fireEvent.input(search, { target: { value: 'Signal' } });
  fireEvent.change(search, { target: { value: 'Signal' } });
  await settle();
  const result = getByRole(document.body, 'table', { name: 'Shows records' });
  assert(result.textContent.includes('The Last Signal'));
  assert(!result.textContent.includes('Harbour Files'));
  assert.equal(document.querySelector('.row-count > span[aria-hidden="true"]').textContent, '1/6');
  await click(getByRole(document.body, 'button', { name: 'Close search' }));
  await click(getByRole(tableTabs, 'tab', { name: 'Episodes', exact: true }));
  assert.equal(
    getByRole(tableTabs, 'tab', { name: 'Episodes', exact: true }).getAttribute('aria-selected'),
    'true'
  );
  assert(getByRole(document.body, 'tabpanel', { name: 'Episodes', exact: true }));
  assert(
    getByRole(document.body, 'table', { name: 'Episodes records' }).textContent.includes(
      'Ground Control'
    )
  );
  assert.equal(
    document.querySelector('.row-count > span[aria-hidden="true"]').textContent,
    '18/18'
  );
  const episodesTab = getByRole(tableTabs, 'tab', { name: 'Episodes', exact: true });
  episodesTab.focus();
  fireEvent.keyDown(episodesTab, { key: 'ArrowLeft' });
  await settle();
  const showsTab = getByRole(tableTabs, 'tab', { name: 'Shows', exact: true });
  assert.equal(document.activeElement, showsTab);
  assert.equal(showsTab.getAttribute('aria-selected'), 'true');
  await click(getByRole(document.body, 'button', { name: 'Working files · 4 definitions' }));
  assert(getByRole(document.body, 'tree', { name: 'Working files' }));
  await click(getByRole(document.body, 'treeitem', { name: 'shows.yml', exact: true }));
  assert(document.querySelector('.code-preview').textContent.includes('Synthetic show identifier'));
  await click(getByRole(document.body, 'button', { name: 'Model lineage' }));
  assert(getByRole(document.body, 'group', { name: 'Declared model dependencies' }));
  assert.equal(
    document.querySelectorAll('.lineage-connectors > path').length,
    saved.lineage.edges.length
  );
  const graphNode = getByRole(document.body, 'button', { name: 'Inspect Episodes definition' });
  fireEvent.keyDown(graphNode, { key: 'Enter' });
  await settle();
  assert(document.querySelector('.file-heading').textContent.includes('sources/episodes.yml'));
  await click(getByRole(document.body, 'button', { name: 'Saved execution evidence' }));
  assert(document.querySelector('.receipt-list').textContent.includes('Synthetic checkpoint'));
  assert(!queryByRole(document.body, 'button', { name: 'Dark theme' }));
  fireEvent.keyDown(getByRole(document.body, 'button', { name: 'More options' }), { key: 'Enter' });
  await settle();
  assert(getByRole(document.body, 'menuitem', { name: 'Previous layout' }));
  assert(getByRole(document.body, 'menuitem', { name: 'Original tutorial' }));
  await click(getByRole(document.body, 'menuitem', { name: 'Use dark theme' }));
  assert.equal(document.documentElement.dataset.theme, 'dark');
  const handoff = getByRole(document.body, 'region', { name: 'Ready to move on?' });
  const snippet = getByRole(handoff, 'region', { name: 'Share this with your agent' });
  const request = snippet.querySelector('code');
  assert(!queryByRole(handoff, 'textbox'));
  assert(request.textContent.includes('Help me work through “Build an ETL pipeline”'));
  await click(getByRole(actions, 'button', { name: 'Mark as reviewed' }));
  assert(getByRole(actions, 'button', { name: 'Reviewed', exact: true }).disabled);
  assert(request.textContent.includes('I’ve reviewed “Build an ETL pipeline”'));
  assert(request.textContent.includes('Continue with “Build semantic models”'));
  const copy = getByRole(snippet, 'button', { name: 'Copy request' });
  await click(copy);
  assert.equal(copied.length, 1);
  assert.equal(copied[0], request.textContent);
  assert(copied[0].includes('synthetic TV Night fixtures'));
  assert(getByRole(snippet, 'button', { name: 'Request copied' }));
  const clipboard = dom.window.navigator.clipboard;
  Object.defineProperty(dom.window.navigator, 'clipboard', {
    value: undefined,
    configurable: true,
  });
  await click(copy);
  assert.equal(document.activeElement, snippet);
  assert.equal(dom.window.getSelection().toString(), request.textContent);
  Object.defineProperty(dom.window.navigator, 'clipboard', {
    value: clipboard,
    configurable: true,
  });
  await click(getByRole(actions, 'button', { name: 'Next step' }));
  assert.equal(
    getByRole(document.body, 'heading', { level: 1 }).textContent,
    'Build semantic models'
  );
  assert(getByRole(actions, 'button', { name: 'Mark as reviewed' }).disabled);
  assert(
    getByRole(document.body, 'region', { name: 'Share this with your agent' })
      .querySelector('code')
      .textContent.includes('Help me work through “Build semantic models”')
  );
  const emptyResult = getByRole(document.querySelector('.empty-results'), 'status');
  assert(emptyResult.textContent.includes('No results yet'));
  assert(!actions.textContent.includes('3/6'));
  assert(!queryByRole(document.body, 'table', { name: 'Shows records' }));
  await click(getByRole(document.body, 'button', { name: 'Working files · 2 definitions' }));
  const modelFiles = getByRole(document.body, 'tree', { name: 'Working files' });
  assert(!modelFiles.textContent.includes('integrations'));
  assert(!modelFiles.textContent.includes('pipelines'));
  assert(
    modelFiles.textContent.includes('shows.yml') && modelFiles.textContent.includes('episodes.yml')
  );
  await click(getByRole(document.body, 'button', { name: 'Model lineage' }));
  assert.equal(document.querySelectorAll('.lineage-connectors > path').length, 0);
  await click(getByRole(emptyResult, 'button', { name: 'Return to current chapter' }));
  assert.equal(
    getByRole(document.body, 'heading', { level: 1 }).textContent,
    'Build an ETL pipeline'
  );
  assert(getByRole(actions, 'button', { name: 'Reviewed', exact: true }).disabled);
  await click(getByRole(actions, 'button', { name: 'Previous' }));
  assert.equal(
    getByRole(document.body, 'heading', { level: 1 }).textContent,
    saved.state.steps[0].label
  );
  assert(!queryByRole(document.body, 'tablist', { name: 'Saved tables' }));
  assert.equal(document.querySelector('.row-count > span[aria-hidden="true"]').textContent, '1/1');
  assert(!queryByRole(actions, 'button', { name: 'Previous' }));
  await click(getByRole(actions, 'button', { name: 'Next step' }));
  assert.equal(
    getByRole(document.body, 'heading', { level: 1 }).textContent,
    'Build an ETL pipeline'
  );
  await click(getByRole(document.body, 'button', { name: /Entity resolution/ }));
  assert(!queryByRole(actions, 'button', { name: 'Next step' }));
  await click(getByRole(actions, 'button', { name: 'Previous' }));
  assert.equal(
    getByRole(document.body, 'heading', { level: 1 }).textContent,
    saved.state.steps.at(-2).label
  );
  await click(getByRole(document.body, 'button', { name: 'Working files · 0 definitions' }));
  assert(!queryByRole(document.body, 'tree', { name: 'Working files' }));
  assert(document.body.textContent.includes('No files for this step yet'));
  assert.deepEqual(errors, []);
  process.stdout.write(
    'Passed: hydration, compact chapter context, embedded brand, active record tracking, data search, result tabs and keyboard navigation, header row counts, chapter-specific files and lineage, graph keyboard activation, comparison menu, themes, first/last navigation, agent request, clipboard fallback, and pending states.\n'
  );
  process.stdout.write(
    'Passed: empty and failed snapshot rendering, bundled fonts and components, and no external runtime resources. These are DOM checks, not visual browser QA.\n'
  );
} finally {
  dom.window.close();
}
