import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // Independent entries so the `catalog`, `validation`, and `actions` subpath bundles do
    // NOT pull in `validate.ts` / the query-resources tree / the
    // `@bobsled-inc/extractor` runtime barrel. See `src/catalog/index.ts` and
    // `src/actions-entry.ts` for the rationale.
    entry: {
      index: 'src/index.ts',
      catalog: 'src/catalog/index.ts',
      validation: 'src/validation/index.ts',
      actions: 'src/actions-entry.ts',
    },
    format: ['esm'],
    dts: true,
    clean: true,
    splitting: false,
  },
]);
