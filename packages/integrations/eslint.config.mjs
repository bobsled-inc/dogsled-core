import baseConfig from '../../eslint.config.base.mjs';

// Generated catalog manifest and embedded built-in sources are large by
// design and authored by `scripts/generate-catalog-manifest.ts` and
// `scripts/generate-builtin-sources.ts`. Excluding them from lint
// (and the per-file size budget) keeps the linter focused on
// hand-authored code.
export default [
  ...baseConfig,
  {
    ignores: ['src/catalog/generated-data.ts', 'src/builtin-sources/generated-data.ts'],
  },
];
