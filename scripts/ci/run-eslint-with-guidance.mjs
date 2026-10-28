import { spawnSync } from 'node:child_process';

import {
  createDocPointer,
  findPackageForFile,
  formatGuidance,
  listWorkspacePackages,
  rootAgentsPath,
} from './shared.mjs';

const RULE_GUIDANCE = {
  '@typescript-eslint/no-explicit-any': {
    summary:
      'Replace `any` with a concrete domain type, `unknown`, or a `z.infer`-derived schema type.',
    agentsSection: 'Code Standards',
    category: 'types',
  },
  '@typescript-eslint/no-unused-vars': {
    summary:
      'Delete dead bindings or prefix intentionally unused values with `_` so the intent is explicit.',
    agentsSection: 'Code Standards',
    category: 'types',
  },
  'dogsled/no-console': {
    summary:
      'Route CLI output through formatter helpers so JSON, quiet, and verbose modes stay correct.',
    agentsSection: 'Code Standards',
    category: 'output',
  },
  'dogsled/no-process-exit': {
    summary: 'Set `process.exitCode` and return so cleanup and test harnesses keep working.',
    agentsSection: 'Code Standards',
    category: 'output',
  },
  'dogsled/import-extension': {
    summary:
      'Use `.js` on relative imports because NodeNext ESM keeps the import specifier verbatim.',
    agentsSection: 'Code Standards',
    category: 'imports',
  },
  'prefer-const': {
    summary: 'Prefer immutable bindings unless the variable is reassigned later in the same scope.',
    agentsSection: 'Code Standards',
    category: 'types',
  },
  eqeqeq: {
    summary:
      'Use strict equality so runtime coercion does not leak into protocol or schema code paths.',
    agentsSection: 'Code Standards',
    category: 'types',
  },
  curly: {
    summary:
      'Use braces around multi-line branches so future edits do not create control-flow bugs.',
    agentsSection: 'Code Standards',
    category: 'types',
  },
  'no-debugger': {
    summary:
      'Remove debugger statements before commit; keep debugging in tests or temporary local edits only.',
    agentsSection: 'Code Standards',
    category: 'types',
  },
  'dogsled/file-size-limit': {
    summary:
      'Split large files before adding more logic so agents can reason about modules locally.',
    agentsSection: 'Code Standards',
    category: 'imports',
  },
};

function printMessage(result, message) {
  const severity = message.severity === 2 ? 'error' : 'warn';
  const ruleId = message.ruleId ?? 'eslint';
  const filePath = result.filePath;
  const location = `${filePath}:${message.line ?? 1}:${message.column ?? 1}`;
  console.log(`${location} ${severity} ${ruleId} ${message.message}`);

  const pkg = findPackageForFile(filePath);
  const guidance = RULE_GUIDANCE[ruleId];
  if (guidance) {
    console.log(
      `  guidance: ${formatGuidance({
        summary: guidance.summary,
        agentsSection: guidance.agentsSection,
        packageDoc: pkg?.agentsPath,
        packageSection:
          pkg?.shortName === 'dogsled' && guidance.category === 'output' ? 'Output Modes' : null,
      })}`
    );
  } else if (pkg) {
    console.log(
      `  guidance: Fix the violation using the established package pattern. See ${createDocPointer(rootAgentsPath, 'Code Standards')} and ${createDocPointer(pkg.agentsPath)}.`
    );
  }
}

const packages = listWorkspacePackages();
const ruleCounts = new Map();
let errorCount = 0;
let warningCount = 0;
let executionFailure = false;

for (const pkg of packages) {
  const run = spawnSync('pnpm', ['exec', 'eslint', '.', '--format', 'json'], {
    cwd: pkg.dir,
    encoding: 'utf8',
    // The default 1 MB stdout cap (`maxBuffer`) is too small: the JSON report
    // for the largest package already exceeds it, which surfaces as a spurious
    // `spawnSync ... ENOBUFS` execution failure rather than a lint result.
    // Raise it well past any realistic single-package report size.
    maxBuffer: 256 * 1024 * 1024,
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      // This helper invokes ESLint once per package; skip pnpm's repeated
      // node_modules verification only for these nested lint invocations.
      PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'false',
      pnpm_config_verify_deps_before_run: 'false',
    },
  });

  if (run.error) {
    executionFailure = true;
    console.error(`Failed to run ESLint for ${pkg.name}: ${run.error.message}`);
    continue;
  }

  if (!run.stdout.trim()) {
    if (run.status && run.status > 1) {
      executionFailure = true;
      console.error(run.stderr.trim());
    }
    continue;
  }

  let results;
  try {
    results = JSON.parse(run.stdout);
  } catch (error) {
    executionFailure = true;
    console.error(
      `Failed to parse ESLint JSON for ${pkg.name}: ${error instanceof Error ? error.message : String(error)}`
    );
    console.error(run.stdout);
    continue;
  }

  for (const result of results) {
    for (const message of result.messages) {
      const ruleId = message.ruleId ?? 'eslint';
      ruleCounts.set(ruleId, (ruleCounts.get(ruleId) ?? 0) + 1);
      if (message.severity === 2) {
        errorCount += 1;
      } else {
        warningCount += 1;
      }
      printMessage(result, message);
    }
  }

  if (run.status && run.status > 1) {
    executionFailure = true;
    if (run.stderr.trim()) {
      console.error(run.stderr.trim());
    }
  }
}

const topRules = [...ruleCounts.entries()]
  .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  .slice(0, 10);

if (topRules.length > 0) {
  console.log('\nTop ESLint rules this run:');
  for (const [ruleId, count] of topRules) {
    const guidance = RULE_GUIDANCE[ruleId];
    const guidanceText = guidance
      ? formatGuidance({
          summary: guidance.summary,
          agentsSection: guidance.agentsSection,
        })
      : `See ${createDocPointer(rootAgentsPath, 'Decision-Making Principles')}.`;
    console.log(`- ${ruleId}: ${count} finding(s). ${guidanceText}`);
  }
}

console.log(`\nESLint summary: ${errorCount} error(s), ${warningCount} warning(s).`);

if (executionFailure || errorCount > 0) {
  process.exitCode = 1;
}
