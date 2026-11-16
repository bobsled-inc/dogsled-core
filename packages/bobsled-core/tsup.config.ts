import { readFileSync } from 'node:fs';

import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8')) as {
  version: string;
};

const define = {
  __CLI_VERSION__: JSON.stringify(pkg.version),
};

export default defineConfig([
  {
    name: 'cli',
    entry: { index: 'src/index.ts', 'commands/model-run': 'src/commands/model-run.ts' },
    format: ['esm'],
    clean: true,
    splitting: false,
    metafile: true,
    noExternal: ['commander'],
    banner: {
      js: `#!/usr/bin/env node
import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);`,
    },
    define,
  },
  {
    name: 'public-apis',
    entry: {
      'public-apis': 'src/public-apis.ts',
      errors: 'src/errors.ts',
      'blueprint-aliases': 'src/blueprint-aliases.ts',
      agentic: 'src/agentic.ts',
      'actions/index': 'src/actions/index.ts',
      'resources/index': 'src/resources/index.ts',
      'project-skills/index': 'src/project-skills/index.ts',
      'mcp/index': 'src/mcp/index.ts',
      manifest: 'src/manifest.ts',
      validation: 'src/validation.ts',
      'pipeline/index': 'src/pipeline/index.ts',
      'reverse-etl/index': 'src/reverse-etl/index.ts',
      'sync/index': 'src/sync/index.ts',
      'schema/index': 'src/schema/index.ts',
      'source-query': 'src/source-query.ts',
      'compat/ai': 'src/compat/ai.ts',
      'compat/ai-test-stubs': 'src/compat/ai-test-stubs.ts',
      'compat/model-spec-agentic': 'src/compat/model-spec-agentic.ts',
      'compat/connections': 'src/compat/connections.ts',
      'compat/document-parsers': 'src/compat/document-parsers.ts',
      'compat/extractor': 'src/compat/extractor.ts',
      'compat/integrations': 'src/compat/integrations.ts',
      'compat/integrations-catalog': 'src/compat/integrations-catalog.ts',
      'compat/model-spec': 'src/compat/model-spec.ts',
      'compat/ontology': 'src/compat/ontology.ts',
      'compat/model-spec-interchange': 'src/compat/model-spec-interchange.ts',
      'compat/model-spec-project': 'src/compat/model-spec-project.ts',
      'compat/model-spec-schemas': 'src/compat/model-spec-schemas.ts',
      'compat/project-index': 'src/compat/project-index.ts',
      'compat/sftp': 'src/compat/sftp.ts',
    },
    format: ['esm'],
    dts: true,
    splitting: false,
    noExternal: ['@bobsled-inc/integrations/validation', '@bobsled-inc/embedder/schema'],
    define,
  },
]);
