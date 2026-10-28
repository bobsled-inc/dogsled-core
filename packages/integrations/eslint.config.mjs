import baseConfig from '../../eslint.config.base.mjs';

// Generated catalog manifest is large by design and authored by
// `scripts/generate-catalog-manifest.ts`. Excluding it from lint
// (and the per-file size budget) keeps the linter focused on
// hand-authored code.
export default [
  ...baseConfig,
  {
    ignores: ['src/catalog/generated-data.ts'],
  },
];
