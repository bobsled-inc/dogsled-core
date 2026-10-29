import { expect, it } from 'vitest';
import { renderFileTree } from '../../../src/runtime/onboarding/file-tree.js';
import { renderGraph } from '../../../src/runtime/onboarding/graph.js';
import {
  teaching,
  teachingPanel,
  tutorialOverview,
} from '../../../src/runtime/onboarding/teaching.js';
it('renders nested folders with filenames, not flattened path buttons', () => {
  const html = renderFileTree([
    { path: 'resources/tvmaze/shows.yml', content: '', language: 'yaml' },
    { path: 'dogsled.yml', content: '', language: 'yaml' },
  ]);
  expect(html).toMatch(/resources<\/summary><ul><li><details open><summary>.*tvmaze<\/summary>/);
  expect(html).toContain('data-tree-file="true"');
  expect(html).toContain('data-file="resources/tvmaze/shows.yml"');
  expect(html).toContain('shows.yml</button>');
  expect(html).not.toContain('>tvmaze/shows.yml</button>');
});
it('renders one directed graph with escaped clickable nodes and real edges', () => {
  const graph = {
    nodes: [
      {
        id: 'sources/a.yml',
        label: '<source>',
        kind: 'source',
        description: 'raw data',
        available: true,
      },
      {
        id: 'models/b.yml',
        label: 'model',
        kind: 'model',
        description: 'derived',
        available: true,
      },
    ],
    edges: [{ from: 'sources/a.yml', to: 'models/b.yml' }],
  };
  const html = renderGraph(graph);
  expect(html.match(/<svg /g)).toHaveLength(1);
  expect(html).toContain('marker-end="url(#dag-arrow)"');
  expect(html).toContain('&lt;source&gt;');
  expect(html).toContain('data-file="models/b.yml"');
  expect(html).not.toContain('<article');
  expect(html).not.toMatch(/ C\d/);
  expect(html).toContain('M1 1 L7 5 L1 9');
  expect(renderGraph({ ...graph, edges: [{ from: 'missing', to: 'models/b.yml' }] })).toContain(
    'unknown dependency'
  );
  expect(renderGraph({ ...graph, nodes: [...graph.nodes, graph.nodes[0]!] })).toContain(
    'unknown dependency'
  );
  expect(
    renderGraph({
      ...graph,
      edges: [...graph.edges, { from: 'models/b.yml', to: 'sources/a.yml' }],
    })
  ).toContain('contain a cycle');
});
it('teaches capabilities, code inspection, natural-language exploration and continuity', () => {
  expect(tutorialOverview).toContain('4. Query your data');
  expect(tutorialOverview).toContain('5. Query across sources');
  expect(teaching.load.now).toContain('No semantic models');
  expect(teaching.query.questions).toContain('Which shows match my preferred genres?');
  expect(teaching.federate.now).toContain('DuckDB');
  expect(teaching.federate.now).toContain('Wikipedia');
  for (const lesson of Object.values(teaching)) {
    expect(lesson.code.length).toBeGreaterThan(0);
    expect(lesson.next.length).toBeGreaterThan(0);
  }
});

it('does not claim results before a chapter completes', () => {
  expect(teachingPanel('federate')).not.toContain('Article text is now available');
  expect(teachingPanel('transform')).not.toContain('You can query structured assessments');
  expect(teachingPanel('transform')).toContain('What you will build');
  expect(teachingPanel('transform', true)).toContain('You can query structured assessments');
  expect(teachingPanel('transform', true)).toContain('At the end of this chapter');
  expect(teachingPanel('transform', true)).not.toContain('You have completed the core tutorial');
});
