import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildOnboardingSnapshot } from '../../../src/runtime/onboarding/snapshot.js';

it('includes safe working files, descriptions and declared lineage without secrets or data dumps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tv-workspace-'));
  try {
    for (const dir of [
      'data/tv-night',
      'models',
      'sources',
      'integrations',
      'queries',
      'reference/models',
      'resources/api',
    ]) {
      await mkdir(join(root, dir), { recursive: true });
    }
    const files = {
      'data/tv-night/manifest.json': '{"version":"1","sources":[]}',
      'data/tv-night/private.json': '{"secret":"PRIVATE DATA"}',
      '.env': 'TOKEN=ENV_SECRET',
      'resources/api/shows.yml': 'type: resource\nname: shows\nintegration: api\n',
      'dogsled.yml':
        'destinations: {warehouse: {schema: raw}}\npipelines: {tv: {source: api, destination: warehouse, resources: [shows]}}\n',
      'integrations/api.yml': 'type: integration\nname: api\napi_key: literal-secret\n',
      'sources/shows.yml': 'type: source\nname: shows\nconnection: warehouse\ntable: raw.shows\n',
      'models/shows.yml':
        'type: model\nname: shows\ndescription: A television series\nsource: {ref: warehouse.shows}\ncolumns:\n- {name: id, expr: id, description: TVmaze identifier}\nsecret: hidden-value\n',
      'models/shortlist.yml':
        'type: model\nname: shortlist\nsource: {ref: shows}\ncolumns: [{name: id, expr: id}]\n',
      'queries/shortlist.sql': 'SELECT * FROM analytics.shortlist;',
      'reference/models/solution.yml.txt': 'name: solution\n',
    };
    for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content);
    const s = await buildOnboardingSnapshot(root);
    expect(s.files?.map((f) => f.path)).toContain('models/shortlist.yml');
    expect(s.files?.some((f) => f.path.startsWith('reference/'))).toBe(false);
    expect(s.lineage?.edges).toContainEqual({ from: 'sources/shows.yml', to: 'models/shows.yml' });
    expect(s.lineage?.edges).toContainEqual({
      from: 'models/shows.yml',
      to: 'models/shortlist.yml',
    });
    expect(s.lineage?.edges).toContainEqual({
      from: 'resources/api/shows.yml',
      to: 'sources/shows.yml',
    });
    expect(s.definitions?.flatMap((d) => d.fields).join(' ')).toContain('TVmaze identifier');
    for (const secret of ['literal-secret', 'hidden-value', 'PRIVATE DATA', 'ENV_SECRET']) {
      expect(JSON.stringify(s)).not.toContain(secret);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
