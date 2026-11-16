import { describe, expect, it } from 'vitest';

import { classifyProjectFile, ROOT_CONFIG_FILE_SPELLINGS } from '../../src/index.js';

// Compatibility test: the rename never rewrites this file. Root configuration files named by
// any Core generation are pipeline configuration; nested files of that name are not.
describe('root configuration file names', () => {
  it.each([
    'track.yml',
    'track.yaml',
    'dogsled.yml',
    'dogsled.yaml',
    'bobsled.yml',
    'bobsled.yaml',
  ])('reads %s as pipeline configuration', (path) => {
    expect(classifyProjectFile({ path, content: 'pipelines: {}\n' })).toMatchObject({
      status: 'recognized',
      entry: { kind: 'pipeline_config' },
    });
  });

  it('is the one list every root configuration finder reads', () => {
    expect([...ROOT_CONFIG_FILE_SPELLINGS].sort()).toEqual(
      [
        'bobsled.yaml',
        'bobsled.yml',
        'dogsled.yaml',
        'dogsled.yml',
        'track.yaml',
        'track.yml',
      ].sort()
    );
  });

  it('keeps integrations/bobsled.yml an integration path, not a root configuration', () => {
    const result = classifyProjectFile({
      path: 'integrations/bobsled.yml',
      content: 'pipelines: {}\n',
    });
    expect(result).not.toMatchObject({ entry: { kind: 'pipeline_config' } });
  });
});
