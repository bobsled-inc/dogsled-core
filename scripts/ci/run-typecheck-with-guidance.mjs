import { spawnSync } from 'node:child_process';

import { findPackageForFile, formatGuidance, rootAgentsPath } from './shared.mjs';

const CODE_GUIDANCE = {
  TS2307: {
    summary:
      'Resolve the import path, prefer workspace package entrypoints for cross-package imports, and keep `.js` on relative ESM imports.',
    agentsSection: 'Configuration And Packages',
  },
  TS2322: {
    summary:
      'Align the assigned value with the declared type instead of widening the type to make the error disappear.',
    agentsSection: 'Code Standards',
  },
  TS2339: {
    summary:
      'Use the existing schema or type contract rather than reaching for undeclared properties.',
    agentsSection: 'Code Standards',
  },
  TS2345: {
    summary:
      'Pass a value that already matches the callee contract or normalize it before the call site.',
    agentsSection: 'Code Standards',
  },
  TS2353: {
    summary:
      'Treat object shapes as strict contracts. Remove unknown keys or update the schema intentionally.',
    agentsSection: 'Architecture Contracts',
  },
  TS7006: {
    summary:
      'Annotate the parameter instead of allowing an implicit `any` to spread through the module.',
    agentsSection: 'Code Standards',
  },
};

function extractTypeScriptErrors(output) {
  const ansiPattern = /\u001B\[[0-9;]*m/g;
  const lines = output.replaceAll(ansiPattern, '').split('\n');
  const errors = [];

  for (const line of lines) {
    const match =
      line.match(
        /^(?<file>.+?)\((?<line>\d+),(?<column>\d+)\): error (?<code>TS\d+): (?<message>.+)$/
      ) ??
      line.match(
        /^(?<file>.+?):(?<line>\d+):(?<column>\d+) - error (?<code>TS\d+): (?<message>.+)$/
      );

    if (!match?.groups) {
      continue;
    }

    errors.push({
      file: match.groups.file,
      line: Number(match.groups.line),
      column: Number(match.groups.column),
      code: match.groups.code,
      message: match.groups.message.trim(),
    });
  }

  return errors;
}

const run = spawnSync('pnpm', ['exec', 'turbo', 'run', 'typecheck', '--output-logs=errors-only'], {
  encoding: 'utf8',
  env: {
    ...process.env,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'false',
    TURBO_TELEMETRY_DISABLED: '1',
    pnpm_config_verify_deps_before_run: 'false',
  },
});

if (run.error) {
  console.error(`Failed to run typecheck: ${run.error.message}`);
  process.exitCode = 1;
} else {
  const combinedOutput = [run.stdout, run.stderr].filter(Boolean).join('\n');
  const errors = extractTypeScriptErrors(combinedOutput);
  const counts = new Map();

  for (const error of errors) {
    counts.set(error.code, (counts.get(error.code) ?? 0) + 1);
    const pkg = findPackageForFile(error.file);
    const guidance = CODE_GUIDANCE[error.code];
    console.log(`${error.file}:${error.line}:${error.column} error ${error.code} ${error.message}`);
    if (guidance) {
      console.log(
        `  guidance: ${formatGuidance({
          summary: guidance.summary,
          agentsSection: guidance.agentsSection,
          packageDoc: pkg?.agentsPath,
          packageSection: null,
        })}`
      );
    }
  }

  const topCodes = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 10);

  if (topCodes.length > 0) {
    console.log('\nTop TypeScript errors this run:');
    for (const [code, count] of topCodes) {
      const guidance = CODE_GUIDANCE[code];
      const guidanceText = guidance
        ? formatGuidance({ summary: guidance.summary, agentsSection: guidance.agentsSection })
        : formatGuidance({ summary: 'Review the type error.', agentsSection: 'Code Standards' });
      console.log(`- ${code}: ${count} diagnostic(s). ${guidanceText}`);
    }
  }

  if (run.status && run.status !== 0) {
    if (!errors.length && combinedOutput.trim()) {
      console.error(combinedOutput.trim());
    }
    process.exitCode = 1;
  }
}
