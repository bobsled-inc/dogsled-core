import { describe, expect, it } from 'vitest';

import { classifyProjectFile } from '../../src/index.js';

// Compatibility test: the rename never rewrites this file. Root configuration files named by
// either Core generation are pipeline configuration; nested files of that name are not.
describe('root configuration file names', () => {
  it.each(['dogsled.yml', 'dogsled.yaml', 'bobsled.yml', 'bobsled.yaml'])(
    'reads %s as pipeline configuration',
    (path) => {
      expect(classifyProjectFile({ path, content: 'pipelines: {}\n' })).toMatchObject({
        status: 'recognized',
        entry: { kind: 'pipeline_config' },
      });
    }
  );

  it('keeps integrations/bobsled.yml an integration path, not a root configuration', () => {
    const result = classifyProjectFile({
      path: 'integrations/bobsled.yml',
      content: 'pipelines: {}\n',
    });
    expect(result).not.toMatchObject({ entry: { kind: 'pipeline_config' } });
  });
});
