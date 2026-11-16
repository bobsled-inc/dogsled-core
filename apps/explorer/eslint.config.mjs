import baseConfig from '../../eslint.config.base.mjs';

export default [
  ...baseConfig,
  {
    // Next.js uses a bundler (webpack/turbopack) that resolves imports
    // without .js extensions, so disable the ESM extension rule.
    rules: {
      'bobsled/import-extension': 'off',
      'bobsled/file-size-limit': 'warn',
    },
  },
  {
    // Next.js route handlers log server-side errors via console.*,
    // which is the idiomatic pattern. The bobsled/no-console rule
    // targets CLI packages that emit Bobsled Core protocol messages on stdout.
    files: ['src/app/api/**/*.ts', 'src/app/api/**/*.tsx'],
    rules: {
      'bobsled/no-console': 'off',
    },
  },
];
