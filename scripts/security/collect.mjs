import { execFileSync } from 'node:child_process';
import path from 'node:path';

import {
  RUN_SCHEMA_VERSION,
  captureCommand,
  ensureDir,
  executablePath,
  parseArgs,
  repoRoot,
  resolveRunDir,
  writeJson,
} from './lib.mjs';

const args = parseArgs();
const requestedStage = args.stage ?? 'all';
const portable = args.portable === true;
const runDir = resolveRunDir(args, { create: true });
const rawDir = ensureDir(path.join(runDir, 'raw'));
const exportDir = path.join(runDir, 'export');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).trim();

const supportedStages = ['disclosure', 'code', 'privacy', 'adversarial'];
const selectedStages =
  requestedStage === 'all'
    ? supportedStages
    : requestedStage.split(',').map((stage) => stage.trim());
for (const stage of selectedStages) {
  if (!supportedStages.includes(stage)) {
    throw new Error(`Unknown stage "${stage}". Expected ${supportedStages.join(', ')}, or all.`);
  }
}

function command(spec) {
  process.stderr.write(`[security:collect] ${spec.id}: starting\n`);
  const result = captureCommand({
    ...spec,
    outputDir: rawDir,
  });
  process.stderr.write(
    `[security:collect] ${spec.id}: ${result.status} (exit ${result.exitCode ?? 'none'})\n`
  );
  return result;
}

function localOrPortable(name, portableSpec) {
  if (executablePath(name)) return { command: name, argsPrefix: [] };
  if (portable && portableSpec) return portableSpec;
  return { command: name, argsPrefix: [] };
}

function collectDisclosure() {
  const commands = [];
  commands.push(
    command({
      id: 'clean-export',
      tool: 'bobsled-export',
      adapter: 'metadata',
      command: process.execPath,
      args: [
        path.join(repoRoot, 'scripts/security/export-worktree.mjs'),
        '--out',
        path.relative(repoRoot, exportDir),
      ],
      versionOverride: 'dogsled security export schema 1',
      versionArgs: ['--version'],
    })
  );

  if (commands.at(-1).status === 'passed') {
    commands.push(
      command({
        id: 'secretlint-export',
        tool: 'secretlint',
        adapter: 'secretlint',
        command: process.execPath,
        args: [
          path.join(repoRoot, 'scripts/security/secretlint-tracked.mjs'),
          '--root',
          exportDir,
          '--json',
        ],
        findingExitCodes: [1],
        versionOverride: 'secretlint 13.0.2',
        versionArgs: ['--version'],
      })
    );

    const gitleaks = portable
      ? {
          command: process.execPath,
          argsPrefix: [
            path.join(repoRoot, 'scripts/security/run-gitleaks-container.mjs'),
            '--export',
            exportDir,
          ],
        }
      : localOrPortable('gitleaks');
    commands.push(
      command({
        id: 'gitleaks-export',
        tool: 'gitleaks',
        adapter: 'gitleaks',
        command: gitleaks.command,
        args: portable
          ? gitleaks.argsPrefix
          : [
              'dir',
              exportDir,
              '--config',
              path.join(repoRoot, '.gitleaks.toml'),
              '--report-format',
              'json',
              '--report-path',
              '/dev/stdout',
              '--no-banner',
              '--redact=100',
            ],
        findingExitCodes: [1],
        versionOverride: portable
          ? 'gitleaks 8.30.1 (container sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f)'
          : undefined,
        versionArgs: portable ? ['--version'] : ['version'],
      })
    );
  }

  commands.push(
    command({
      id: 'npm-config',
      tool: 'npm-config-audit',
      adapter: 'policy',
      command: process.execPath,
      args: [path.join(repoRoot, 'scripts/security/npm-config-audit.mjs')],
      versionOverride: 'dogsled npm-config audit schema 1',
      versionArgs: ['--version'],
    })
  );
  commands.push(
    command({
      id: 'repository-policy',
      tool: 'bobsled-policy',
      adapter: 'policy',
      command: process.execPath,
      args: [path.join(repoRoot, 'scripts/security/policy.mjs')],
      findingExitCodes: [1],
      versionOverride: 'dogsled repository policy schema 1',
      versionArgs: ['--version'],
    })
  );
  return commands;
}

function collectCode() {
  const commands = [];
  const semgrep = localOrPortable('semgrep', {
    command: 'docker',
    argsPrefix: [
      'run',
      '--rm',
      '--pull=never',
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=512m',
      '--env',
      'HOME=/tmp',
      '-v',
      `${repoRoot}:/src:ro`,
      '--workdir',
      '/src',
      'semgrep/semgrep@sha256:bdf7013b2c3634a487671158da77c554f531742326b543a9464d2adf6c433ac8',
      'semgrep',
    ],
  });
  commands.push(
    command({
      id: 'semgrep',
      tool: 'semgrep',
      adapter: 'semgrep',
      command: semgrep.command,
      args: [
        ...semgrep.argsPrefix,
        'scan',
        `--config=${
          semgrep.command === 'docker' ? '/src/.semgrep.yml' : path.join(repoRoot, '.semgrep.yml')
        }`,
        '--metrics=off',
        '--disable-version-check',
        '--json',
        '--exclude=.security-review',
        '--exclude=node_modules',
        '.',
      ],
      findingExitCodes: [1],
      versionOverride:
        semgrep.command === 'docker'
          ? 'semgrep 1.171.0 (container sha256:bdf7013b2c3634a487671158da77c554f531742326b543a9464d2adf6c433ac8)'
          : undefined,
      timeoutMs: 30 * 60 * 1000,
    })
  );
  commands.push(
    command({
      id: 'pnpm-audit',
      tool: 'pnpm-audit',
      adapter: 'pnpm-audit',
      command: 'pnpm',
      args: ['audit', '--prod', '--audit-level', 'high', '--json'],
      findingExitCodes: [1],
      timeoutMs: 10 * 60 * 1000,
    })
  );

  const osv = localOrPortable('osv-scanner', {
    command: 'docker',
    argsPrefix: [
      'run',
      '--rm',
      '--pull=never',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '-v',
      `${path.join(repoRoot, 'pnpm-lock.yaml')}:/repo/pnpm-lock.yaml:ro`,
      'ghcr.io/google/osv-scanner@sha256:5116601dedc01c1c580eb92371883ec052fc4c13c3fbc109d621a63ac416d475',
    ],
  });
  commands.push(
    command({
      id: 'osv',
      tool: 'osv-scanner',
      adapter: 'osv',
      command: osv.command,
      args: [
        ...osv.argsPrefix,
        'scan',
        `--lockfile=${
          osv.command === 'docker' ? '/repo/pnpm-lock.yaml' : path.join(repoRoot, 'pnpm-lock.yaml')
        }`,
        '--format=json',
      ],
      findingExitCodes: [1],
      versionOverride:
        osv.command === 'docker'
          ? 'osv-scanner 2.4.0 (container sha256:5116601dedc01c1c580eb92371883ec052fc4c13c3fbc109d621a63ac416d475)'
          : undefined,
      timeoutMs: 20 * 60 * 1000,
    })
  );

  const zizmor = localOrPortable('zizmor', {
    command: 'docker',
    argsPrefix: [
      'run',
      '--rm',
      '--pull=never',
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '-v',
      `${repoRoot}:/repo:ro`,
      '--workdir',
      '/repo',
      'ghcr.io/zizmorcore/zizmor@sha256:8e6b3e4fb74d1aa5d23e83ea369f386c66eced0d1fb944d32cd8b2aac100b00d',
    ],
  });
  commands.push(
    command({
      id: 'zizmor',
      tool: 'zizmor',
      adapter: 'sarif',
      command: zizmor.command,
      args: [...zizmor.argsPrefix, '--format=sarif', '--offline', '.github'],
      findingExitCodes: [1],
      versionOverride:
        zizmor.command === 'docker'
          ? 'zizmor 1.28.0 (container sha256:8e6b3e4fb74d1aa5d23e83ea369f386c66eced0d1fb944d32cd8b2aac100b00d)'
          : undefined,
      timeoutMs: 15 * 60 * 1000,
    })
  );

  const actionlint = localOrPortable('actionlint', {
    command: 'docker',
    argsPrefix: [
      'run',
      '--rm',
      '--pull=never',
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '-v',
      `${repoRoot}:/repo:ro`,
      '--workdir',
      '/repo',
      'rhysd/actionlint@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667',
    ],
  });
  commands.push(
    command({
      id: 'actionlint',
      tool: 'actionlint',
      adapter: 'actionlint',
      command: actionlint.command,
      args: [...actionlint.argsPrefix, '-format', '{{json .}}'],
      findingExitCodes: [1],
      versionOverride:
        actionlint.command === 'docker'
          ? 'actionlint 1.7.12 (container sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667)'
          : undefined,
      timeoutMs: 15 * 60 * 1000,
    })
  );
  return commands;
}

function collectPrivacy() {
  return [
    command({
      id: 'privacy-inventory',
      tool: 'privacy-inventory',
      adapter: 'policy',
      command: process.execPath,
      args: [path.join(repoRoot, 'scripts/security/privacy-inventory.mjs')],
      findingExitCodes: [1],
      versionOverride: 'dogsled privacy inventory schema 1',
      versionArgs: ['--version'],
    }),
  ];
}

function collectAdversarial() {
  return [
    command({
      id: 'security-properties',
      tool: 'vitest-security-properties',
      adapter: 'vitest',
      command: 'pnpm',
      args: [
        'exec',
        'vitest',
        'run',
        '--config',
        './vitest.security.config.mjs',
        '--reporter=json',
      ],
      findingExitCodes: [1],
      versionOverride: 'vitest 4.1.7 with fast-check 4.9.0',
    }),
  ];
}

const collectors = {
  disclosure: collectDisclosure,
  code: collectCode,
  privacy: collectPrivacy,
  adversarial: collectAdversarial,
};

const stages = {};
for (const stage of selectedStages) {
  const commands = collectors[stage]();
  stages[stage] = {
    status: commands.some((entry) => ['failed', 'unavailable'].includes(entry.status))
      ? 'incomplete'
      : 'collected',
    commands,
  };
}

const run = {
  schemaVersion: RUN_SCHEMA_VERSION,
  runId: path.basename(runDir),
  startedAt: Object.values(stages)
    .flatMap((stage) => stage.commands)
    .map((entry) => entry.startedAt)
    .sort()[0],
  finishedAt: new Date().toISOString(),
  repositoryCommit: commit,
  worktreeDirty:
    execFileSync('git', ['status', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim().length > 0,
  publicationModel: 'clean-export-new-root',
  privateHistoryWillRemainPrivate: true,
  portableToolsEnabled: portable,
  stages,
};
writeJson(path.join(runDir, 'run.json'), run);
process.stdout.write(`${path.relative(repoRoot, runDir)}\n`);
if (Object.values(stages).some((stage) => stage.status === 'incomplete')) process.exitCode = 2;
