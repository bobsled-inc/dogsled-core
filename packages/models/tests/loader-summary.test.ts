import { afterEach, expect, test, vi } from 'vitest';

vi.mock('@bobsled-inc/integrations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bobsled-inc/integrations')>();
  return {
    ...actual,
    getResources: vi.fn(() => {
      throw new Error('listModelPackages must not parse full resource specs');
    }),
  };
});

import * as integrations from '@bobsled-inc/integrations';
import { clearModelPackageCache, listModelPackages } from '../src/index.js';

afterEach(() => {
  clearModelPackageCache();
  vi.clearAllMocks();
});

test('lists package summaries without parsing full resource specs', () => {
  const packages = listModelPackages();
  const stripe = packages.find((entry) => entry.name === 'stripe');

  expect(packages.length).toBeGreaterThan(0);
  expect(stripe?.metricCount).toBe(4);
  expect(stripe?.relationshipCount).toBe(4);
  expect(stripe?.totalFiles).toBe(
    stripe!.resourceCount * 2 + stripe!.martCount + stripe!.metricCount + stripe!.relationshipCount
  );
  expect(integrations.getResources).not.toHaveBeenCalled();
});
