import { createOntologyTools } from '@bobsled-inc/model-spec/ontology';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { copyExample } from '../../../src/commands/examples.js';
import { getTutorial, resolveTutorial } from '../../../src/runtime/onboarding/tutorials.js';
import { buildOnboardingSnapshot } from '../../../src/runtime/onboarding/snapshot.js';
import { renderOnboardingHtml } from '../../../src/runtime/onboarding/render.js';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it('scaffolds retail without completed models and renders through the shared engine', async () => {
  expect(getTutorial('retail').skill).toBe('dogsled-retail');
  const root = await mkdtemp(join(tmpdir(), 'retail-tutorial-'));
  roots.push(root);
  copyExample('retail', root);
  expect((await resolveTutorial(root)).id).toBe('retail');
  const ontology = createOntologyTools({ projectRoot: root, authorize: () => true });
  expect(await ontology.call('ontology_validate', { strict: true })).toMatchObject({
    ok: true,
    diagnostics: [],
  });
  const context = await ontology.call('ontology_describe', {
    ontology: 'retail',
    concept: 'SalesLine',
  });
  expect(context).toMatchObject({
    concepts: expect.arrayContaining([
      expect.objectContaining({ concept: 'SalesLine' }),
      expect.objectContaining({ concept: 'Product' }),
      expect.objectContaining({ concept: 'Supplier' }),
    ]),
    mappings: [
      expect.objectContaining({ document: expect.objectContaining({ name: 'retail_warehouse' }) }),
    ],
  });
  await expect(access(join(root, 'reference'))).rejects.toThrow();
  await expect(access(join(root, 'models/product_performance.yml'))).rejects.toThrow();
  await expect(access(join(root, 'data.duckdb'))).rejects.toThrow();
  expect(await readFile(join(root, 'data/retail/products.csv'), 'utf8')).toContain('product_id');
  const snapshot = await buildOnboardingSnapshot(root);
  expect(snapshot.state.steps).toHaveLength(6);
  const html = renderOnboardingHtml(snapshot);
  expect(html).toContain('Retail');
  expect(html).not.toMatch(/TVmaze|Wikipedia|TV Night|spoiler|finalist/);
});
it('rejects missing rows and invalid product performance rather than accepting any table', () => {
  const tutorial = getTutorial('retail');
  for (const { id } of tutorial.steps) {
    expect(() => tutorial.validate(id, [], {})).toThrow();
  }
  expect(() =>
    tutorial.validate(
      'model',
      [
        {
          name: 'Product performance',
          columns: ['product_id'],
          rows: [{ product_id: 'A' }],
          totalRows: 1,
        },
      ],
      {}
    )
  ).toThrow();
});
it('checks a retail pilot without writing progress and rejects injected ticket IDs', async () => {
  const tutorial = getTutorial('retail');
  for (const ticketId of ["case-0001' OR 1=1 --", '../x', '1', 'case-1']) {
    expect(() => tutorial.prepareCheck('transform', { ticketId })).toThrow();
  }
  expect(() => tutorial.prepareCheck('query', { ticketId: 'case-0001' })).toThrow();
  expect(() => tutorial.prepareCheck('transform', { showId: 1 })).toThrow();
  expect(() =>
    getTutorial('tv-night').prepareCheck('transform', { ticketId: 'case-0001' })
  ).toThrow();
  const root = await mkdtemp(join(tmpdir(), 'retail-pilot-'));
  roots.push(root);
  copyExample('retail', root);
  const { verifyOnboarding } = await import('../../../src/runtime/onboarding/verify.js');
  const row = {
    ticket_id: 'case-0001',
    product_id: null,
    expected_product_id: null,
    conversation: 'Please identify the item.',
    in_batch: true,
    input_matches_source: true,
    support_quote: 'identify the item',
    evidence_summary: 'The item is unclear.',
    issue_category: 'other',
    resolution_type: 'awaiting_customer',
    analysis_mode: 'model',
    batch_count: 3,
  };
  const result = await verifyOnboarding(
    root,
    'transform',
    async (_root, sql) => {
      expect(sql).toContain("WHERE c.ticket_id = 'case-0001'");
      return { rows: [row] };
    },
    { ticketId: 'case-0001' }
  );
  expect(result.receipts.join(' ')).toContain('Pilot');
  await expect(access(join(root, '.bobsled/onboarding/transform.json'))).rejects.toThrow();
  await expect(access(join(root, '.bobsled/onboarding/transform.attempt.json'))).rejects.toThrow();
  for (const changed of [
    { analysis_mode: 'fixture' },
    { product_id: 'invented' },
    { support_quote: 'invented' },
    { ticket_id: 'case-0002' },
  ]) {
    expect(() =>
      tutorial.validate(
        'transform',
        [
          {
            name: 'Support findings',
            columns: Object.keys(row),
            rows: [{ ...row, ...changed }],
            totalRows: 1,
          },
        ],
        { ticketId: 'case-0001' }
      )
    ).toThrow();
  }
  expect(() =>
    tutorial.validate(
      'transform',
      [{ name: 'Support findings', columns: Object.keys(row), rows: [row], totalRows: 1 }],
      {}
    )
  ).toThrow();
});

it('routes a mixed federation check to the API adapter and local database separately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retail-federation-'));
  roots.push(root);
  copyExample('retail', root);
  const { verifyOnboarding } = await import('../../../src/runtime/onboarding/verify.js');
  const routes: boolean[] = [];
  await verifyOnboarding(root, 'federate', async (_root, sql, remote) => {
    routes.push(remote);
    return {
      rows: sql.includes('sources.external_reviews')
        ? [{ product_id: 'lmp-009', review_id: 'R1', review_text: 'A review' }]
        : [
            {
              case_count: 40,
              ambiguous_count: 10,
              expected_ambiguous_count: 10,
              identity_mismatches: 0,
            },
          ],
    };
  });
  expect(routes).toEqual([true, false]);
});

it('labels evidence live when any query explicitly uses the remote adapter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retail-route-'));
  roots.push(root);
  copyExample('retail', root);
  const { verifyOnboarding } = await import('../../../src/runtime/onboarding/verify.js');
  const tutorial = {
    ...getTutorial('retail'),
    prepareCheck: () => ({
      queries: [{ name: 'Remote sample', sql: 'SELECT 1', remote: true }],
      remote: false,
      persist: false,
      receipts: [],
    }),
    validate: () => {},
  };
  const evidence = await verifyOnboarding(
    root,
    'connect',
    async () => ({ rows: [{ value: 1 }] }),
    {},
    tutorial
  );
  expect(evidence.mode).toBe('live');
});

it('rejects guessed ambiguous identities', () => {
  const tutorial = getTutorial('retail');
  expect(() =>
    tutorial.validate(
      'federate',
      [
        {
          name: 'Products and reviews',
          columns: [],
          totalRows: 1,
          rows: [{ product_id: 'lmp-009', review_id: 'r1', review_text: 'A review' }],
        },
        {
          name: 'Support identity',
          columns: [],
          totalRows: 1,
          rows: [{ case_count: 40, ambiguous_count: 1 }],
        },
      ],
      {}
    )
  ).toThrow();
});

it('rejects invented but internally consistent products', () => {
  const tutorial = getTutorial('retail');
  const rows = Array.from({ length: 24 }, (_, i) => ({
    product_id: `invented-${i}`,
    product_name: 'Invented',
    sold_units: 0,
    returned_units: 0,
    gross_sales: 0,
    refunds: 0,
    net_sales: 0,
    in_stock_days: 0,
    tracked_days: 61,
    net_sales_per_in_stock_day: null,
  }));
  expect(() =>
    tutorial.validate(
      'model',
      [{ name: 'Product performance', columns: Object.keys(rows[0]!), rows, totalRows: 24 }],
      {}
    )
  ).toThrow();
});
