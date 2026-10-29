import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { expect, it } from 'vitest';
import { IntegrationSpecSchema, ResourceSpecSchema } from '@bobsled-inc/extractor/extractor';
import { SourceSpecSchema, ResolutionSpecSchema } from '@bobsled-inc/model-spec';
import { ModelSpecSchema } from '@bobsled-inc/model-spec/agentic';
const base = new URL('../../../examples/tv-night/', import.meta.url);
const read = (path: string) => YAML.parse(readFileSync(new URL(path, base), 'utf8'));
it('starts without bundled records or active models', () => {
  expect(existsSync(fileURLToPath(new URL('models/', base)))).toBe(false);
  expect(readdirSync(new URL('data/tv-night/', base))).toEqual(['manifest.json']);
  expect(
    read('data/tv-night/manifest.json').sources.every((s: { rows: number }) => s.rows === 0)
  ).toBe(true);
});
it('fetches a bounded index page and fans out episodes and cast from those shows', () => {
  const pipeline = read('reference/dogsled.yml.txt').pipelines.tv;
  expect(pipeline.resources[0].input_matrix.axes.page).toEqual([0]);
  const shows = read('reference/resources/tvmaze/shows.yml.txt');
  expect(shows.api.endpoint).toBe('/shows');
  expect(shows.api.query_params.page).toBe('${{ input.page }}');
  expect(shows.extract.pagination).toBeUndefined();
  for (const name of ['episodes', 'cast']) {
    const child = read(`reference/resources/tvmaze/${name}.yml.txt`);
    expect(child.extract.for_each).toEqual({ resource: 'shows', field: 'id', input: 'show_id' });
    expect(child.output.show_id.from).toEqual({ resource: 'shows', path: '$.id' });
  }
});

it('validates inactive API, source and model references against real schemas', () => {
  for (const name of ['tvmaze', 'wikipedia']) {
    IntegrationSpecSchema.parse(read(`reference/integrations/${name}.yml.txt`));
  }
  for (const name of ['shows', 'episodes', 'cast', 'probe', 'search']) {
    ResourceSpecSchema.parse(read(`reference/resources/tvmaze/${name}.yml.txt`));
  }
  ResourceSpecSchema.parse(read('reference/resources/wikipedia/articles.yml.txt'));
  ResourceSpecSchema.parse(read('reference/resources/wikipedia/full_article.yml.txt'));
  for (const name of ['shows', 'episodes', 'cast', 'tvmaze_probe', 'wikipedia_articles']) {
    SourceSpecSchema.parse(read(`reference/sources/${name}.yml.txt`));
  }
  for (const name of [
    'shows',
    'episodes',
    'watch_next',
    'assessment_inputs',
    'show_notes',
    'recommendations',
  ]) {
    ModelSpecSchema.parse(read(`reference/models/${name}.yml.txt`));
  }
});

it('validates the real watchlist resolution reference', () => {
  ResolutionSpecSchema.parse(read('reference/entity-graph/watchlist_resolution.yml.txt'));
});

it('keeps source meaning and field descriptions in schema-validated teaching templates', () => {
  for (const name of ['shows', 'episodes']) {
    const source = SourceSpecSchema.parse(read(`reference/sources/${name}.yml.txt`));
    expect(source.description).toContain('One row per fetched');
    expect(source.ai_context).toBeDefined();
    expect(source.schema?.columns.every((column) => Boolean(column.description))).toBe(true);
  }
});
