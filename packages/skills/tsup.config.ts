import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // Independent entries keep the Dogsled catalog and Project Skill parser
    // island (no transitive deps) for agent-side consumers that just
    // want the skill manifest. Mirrors the catalog split in
    // `@bobsled-inc/integrations`.
    entry: {
      index: 'src/index.ts',
      bobsled: 'src/bobsled.ts',
      'project/index': 'src/project/index.ts',
    },
    format: ['esm'],
    dts: true,
    clean: true,
    splitting: false,
  },
]);
