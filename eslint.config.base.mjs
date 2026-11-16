import typescriptEslintPlugin from '@typescript-eslint/eslint-plugin';
import typescriptParser from '@typescript-eslint/parser';
import globals from 'globals';

const OFF = 'off';
const WARN = 'warn';
const ERROR = 'error';

// ---------------------------------------------------------------------------
// Custom rules with agent-friendly remediation messages
// ---------------------------------------------------------------------------
// These rules encode project conventions from AGENTS.md as lint errors.
// Error messages are designed to inject remediation context into agent loops
// so that AI coding agents can self-correct without human intervention.
// ---------------------------------------------------------------------------

const FILE_SIZE_LIMIT = 400;

const customRules = {
  /** Warn when a file exceeds FILE_SIZE_LIMIT lines. */
  'bobsled/file-size-limit': {
    meta: {
      type: 'suggestion',
      messages: {
        tooLong: [
          `This file has {{ lineCount }} lines, exceeding the ${FILE_SIZE_LIMIT}-line guideline.`,
          'Split it: extract helpers, types, or constants into a sibling module.',
          'See AGENTS.md "Code Standards" for architecture guidance.',
        ].join(' '),
      },
      schema: [],
    },
    create(context) {
      return {
        'Program:exit'(node) {
          const lineCount = context.sourceCode.lines.length;
          if (lineCount > FILE_SIZE_LIMIT) {
            context.report({
              node,
              messageId: 'tooLong',
              data: { lineCount: String(lineCount) },
            });
          }
        },
      };
    },
  },

  /** Forbid console.log/error/warn — use fmt.* from lib/output/formatter.ts. */
  'bobsled/no-console': {
    meta: {
      type: 'problem',
      messages: {
        noConsole: [
          'Do not use console.{{ method }}().',
          'Use fmt.info(), fmt.error(), fmt.success(), or fmt.debug() from lib/output/formatter.ts instead.',
          'This ensures --json, --quiet, and --verbose flags work correctly.',
          'See AGENTS.md "Code Standards" for output conventions.',
        ].join(' '),
      },
      schema: [],
    },
    create(context) {
      return {
        MemberExpression(node) {
          if (
            node.object.type === 'Identifier' &&
            node.object.name === 'console' &&
            node.property.type === 'Identifier' &&
            ['log', 'error', 'warn', 'info'].includes(node.property.name)
          ) {
            context.report({
              node,
              messageId: 'noConsole',
              data: { method: node.property.name },
            });
          }
        },
      };
    },
  },

  /** Forbid process.exit() — use process.exitCode = N; return; instead. */
  'bobsled/no-process-exit': {
    meta: {
      type: 'problem',
      messages: {
        noExit: [
          'Do not call process.exit().',
          'Set process.exitCode = N and return instead.',
          'Exit codes: 0 = success, 1 = runtime error, 2 = validation error, 3 = drift detected.',
          'process.exit() skips cleanup and breaks testability.',
          'See AGENTS.md "Code Standards" for error handling.',
        ].join(' '),
      },
      schema: [],
    },
    create(context) {
      return {
        CallExpression(node) {
          if (
            node.callee.type === 'MemberExpression' &&
            node.callee.object.type === 'Identifier' &&
            node.callee.object.name === 'process' &&
            node.callee.property.type === 'Identifier' &&
            node.callee.property.name === 'exit'
          ) {
            context.report({ node, messageId: 'noExit' });
          }
        },
      };
    },
  },

  /** Require .js extension on relative imports (ESM requirement). */
  'bobsled/import-extension': {
    meta: {
      type: 'problem',
      messages: {
        missingExtension: [
          "Relative imports must use .js extension (ESM requirement): '{{ source }}.js'.",
          'TypeScript compiles .ts to .js but does not rewrite import specifiers.',
          'See AGENTS.md "Code Standards" for TypeScript conventions.',
        ].join(' '),
      },
      schema: [],
    },
    create(context) {
      function check(node) {
        const source = node.source?.value;
        if (!source || typeof source !== 'string') return;
        // Only check relative imports
        if (!source.startsWith('.')) return;
        // Skip if already has an extension
        if (/\.\w+$/.test(source)) return;
        context.report({
          node,
          messageId: 'missingExtension',
          data: { source },
        });
      }
      return {
        ImportDeclaration: check,
        ExportNamedDeclaration: check,
        ExportAllDeclaration: check,
      };
    },
  },
};

// ---------------------------------------------------------------------------
// Build the custom plugin object for ESLint flat config
// ---------------------------------------------------------------------------
const bobsledPlugin = {
  rules: Object.fromEntries(
    Object.entries(customRules).map(([key, rule]) => [key.replace('bobsled/', ''), rule])
  ),
};

// ---------------------------------------------------------------------------
// Main config
// ---------------------------------------------------------------------------
const eslintConfig = [
  {
    ignores: ['node_modules/**', '**/dist/**', '*.config.mjs', '*.config.ts'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      '@typescript-eslint': typescriptEslintPlugin,
      bobsled: bobsledPlugin,
    },
    rules: {
      // --- TypeScript rules ---
      '@typescript-eslint/no-explicit-any': ERROR,
      '@typescript-eslint/no-unused-vars': [
        ERROR,
        {
          args: 'after-used',
          ignoreRestSiblings: true,
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          argsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/explicit-function-return-type': OFF,
      '@typescript-eslint/explicit-module-boundary-types': OFF,
      '@typescript-eslint/no-non-null-assertion': OFF,

      // --- Core rules ---
      'no-debugger': ERROR,
      'prefer-const': ERROR,
      'no-var': ERROR,
      eqeqeq: [ERROR, 'always', { null: 'ignore' }],
      curly: [ERROR, 'multi-line'],

      // --- Custom agent-friendly rules ---
      'bobsled/file-size-limit': WARN,
      'bobsled/no-console': ERROR,
      'bobsled/no-process-exit': ERROR,
      'bobsled/import-extension': ERROR,
    },
  },
  // Relax rules for test files — console, large files, and bare imports are acceptable
  {
    files: ['**/tests/**/*.ts', '**/*.test.ts'],
    rules: {
      'bobsled/file-size-limit': OFF,
      'bobsled/no-console': OFF,
      'bobsled/import-extension': OFF,
    },
  },
];

export default eslintConfig;
