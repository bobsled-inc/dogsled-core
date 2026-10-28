import baseConfig from '../../eslint.config.base.mjs';

/** @type {import('eslint').Linter.Config[]} */
export default [
  ...baseConfig,
  {
    // Enforce the activate↔extract isolation boundary.
    // runtime/activate/** handles write-back dispatch; runtime/extract/** handles read-only extraction.
    // Mixing them would conflate two distinct concerns and risk importing DuckDB-heavy extraction
    // runtime into the lightweight activate dispatch path.
    files: ['src/runtime/activate/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '../extract/**',
                '../index',
                '../index.js',
                '**/runtime/extract/**',
                '**/runtime/index*',
              ],
              message:
                'runtime/activate/** must not import from runtime/extract/** or the runtime barrel (runtime/index). ' +
                'Keep activate dispatch isolated from the extraction runtime. ' +
                'Import directly from framework/* or activate/* siblings instead.',
            },
          ],
        },
      ],
    },
  },
];
