import { deepStrictEqual, doesNotMatch, match, ok } from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { describe, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  listFilesRecursively,
  listTrackedFiles,
  listWorkspacePackages,
  parseLastReviewed,
  relativeToRepo,
  repoRoot,
} from '../../scripts/ci/shared.mjs';
import { BUNDLED_EXTERNAL_PACKAGE_NAMES } from '../../scripts/release/package-set.mjs';
import { parseReleaseAgeExemptions } from '../../scripts/security/consumer-policy.mjs';
import { expiryStatus, EXEMPTION_GRACE_DAYS } from '../../scripts/security/expiry-dates.mjs';

const REQUIRED_SCRIPTS = ['build', 'typecheck', 'lint', 'test:unit'];

function assertNoViolations(violations, heading, docPointer) {
  if (violations.length > 0) {
    throw new Error(
      `${heading}\n${violations.map((item) => `- ${item}`).join('\n')}\nSee ${docPointer}.`
    );
  }
}

function resolveImportTarget(importerPath, specifier) {
  const basePath = path.resolve(path.dirname(importerPath), specifier);
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.js`,
    `${basePath}.mts`,
    `${basePath}.cts`,
    path.join(basePath, 'index.ts'),
    path.join(basePath, 'index.js'),
  ];

  return candidates.find((candidate) => {
    return existsSync(candidate);
  });
}

function collectPatternViolations({
  allowlistedPaths = new Set(),
  fileFilter,
  messageForMatch,
  patterns,
  stopAfterFirstMatchPerFile = false,
  trackedOnly = false,
}) {
  const violations = [];
  const candidateFiles = trackedOnly
    ? listTrackedFiles(fileFilter)
    : listFilesRecursively(repoRoot, fileFilter);

  for (const filePath of candidateFiles) {
    if (!existsSync(filePath)) {
      continue;
    }

    const relativePath = relativeToRepo(filePath);
    if (allowlistedPaths.has(relativePath)) {
      continue;
    }

    const content = readFileSync(filePath, 'utf8');
    for (const pattern of patterns) {
      if (pattern.test(content)) {
        violations.push(messageForMatch({ pattern, relativePath }));
        if (stopAfterFirstMatchPerFile) {
          break;
        }
      }
    }
  }

  return violations;
}

describe('workspace package conventions', () => {
  it('every workspace package exposes the standard CI scripts', () => {
    const violations = [];
    for (const pkg of listWorkspacePackages()) {
      for (const scriptName of REQUIRED_SCRIPTS) {
        if (!pkg.packageJson.scripts?.[scriptName]) {
          violations.push(`${pkg.name} is missing package.json script "${scriptName}"`);
        }
      }
    }

    assertNoViolations(
      violations,
      'Workspace packages must expose the standard CI scripts so the root workflow can fan out safely.',
      'AGENTS.md -> Testing And Documentation'
    );
  });

  it('hashes package-local TypeScript configs for typecheck tasks', () => {
    const dryRun = JSON.parse(
      execFileSync(
        'pnpm',
        ['exec', 'turbo', 'run', 'typecheck', '--filter=@bobsled-inc/loader', '--dry=json'],
        { cwd: repoRoot, encoding: 'utf8' }
      )
    );
    const loaderTypecheck = dryRun.tasks.find(
      (task) => task.taskId === '@bobsled-inc/loader#typecheck'
    );

    ok(loaderTypecheck, 'Turbo dry-run must include the loader typecheck task');
    for (const configPath of ['tsconfig.json', 'tsconfig.cli-tests.json']) {
      ok(
        Object.hasOwn(loaderTypecheck.inputs, configPath),
        `Loader typecheck cache inputs must include ${configPath}`
      );
    }
  });

  it('every workspace package ships a current AGENTS.md', () => {
    const violations = [];
    for (const pkg of listWorkspacePackages()) {
      try {
        const content = readFileSync(pkg.agentsPath, 'utf8');
        if (!parseLastReviewed(content)) {
          violations.push(`${pkg.name} AGENTS.md is missing last-reviewed metadata`);
        }
      } catch {
        violations.push(`${pkg.name} is missing ${relativeToRepo(pkg.agentsPath)}`);
      }
    }

    assertNoViolations(
      violations,
      'Workspace packages must keep package-level agent docs current.',
      'AGENTS.md -> Testing And Documentation'
    );
  });

  it('uses AGENTS.md as the only agent instruction filename', () => {
    const modelSpecificGuides = listTrackedFiles((filePath) => {
      const filename = path.basename(filePath).toUpperCase();
      return existsSync(filePath) && (filename === 'CLAUDE.MD' || filename === 'GEMINI.MD');
    }).map((filePath) => relativeToRepo(filePath));

    assertNoViolations(
      modelSpecificGuides,
      'Model-specific instruction files create duplicated and conflicting guidance. Use the nearest AGENTS.md.',
      'AGENTS.md -> Working In This Repository'
    );
  });

  it('uses .agents as the only authored skill tree', () => {
    const compatibilityPath = path.join(repoRoot, '.claude', 'skills');
    const violations = [];
    if (!lstatSync(compatibilityPath).isSymbolicLink()) {
      violations.push('.claude/skills must be a compatibility symlink');
    } else if (readlinkSync(compatibilityPath) !== '../.agents/skills') {
      violations.push('.claude/skills must target ../.agents/skills');
    }

    const trackedPaths = execFileSync('git', ['ls-files', '-z'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean);
    const projectSkillDocs = new Set(['docs/getting-started.md', 'docs/guides/project-skills.md']);

    function isProjectSkillAdapter(trackedPath) {
      const match = trackedPath.match(/^(.*)\.claude\/skills\/([^/]+)$/);
      if (!match) return false;
      const projectPrefix = match[1] ?? '';
      const skillName = match[2];
      const adapterPath = path.join(repoRoot, trackedPath);
      if (!lstatSync(adapterPath).isSymbolicLink()) return false;
      const resolvedTarget = path.resolve(path.dirname(adapterPath), readlinkSync(adapterPath));
      const expectedTarget = path.join(repoRoot, projectPrefix, 'skills', skillName);
      return resolvedTarget === expectedTarget && existsSync(path.join(expectedTarget, 'SKILL.md'));
    }
    const skillDirs = readdirSync(path.join(repoRoot, '.agents', 'skills'), {
      withFileTypes: true,
    }).filter((entry) => entry.isDirectory());
    const intentionalAliases = new Map();
    for (const entry of skillDirs) {
      const skillPath = path.join(repoRoot, '.agents', 'skills', entry.name, 'SKILL.md');
      if (!existsSync(skillPath)) {
        violations.push(`.agents/skills/${entry.name} is missing SKILL.md`);
        continue;
      }
      const content = readFileSync(skillPath, 'utf8');
      const name = content.match(/^name:\s*(.+)$/m)?.[1]?.trim();
      if (name !== entry.name && intentionalAliases.get(entry.name) !== name) {
        violations.push(
          `.agents/skills/${entry.name}/SKILL.md declares name "${name ?? 'missing'}"`
        );
      }
      if (/^allowed-tools:/m.test(content)) {
        violations.push(
          `.agents/skills/${entry.name}/SKILL.md contains model-specific allowed-tools metadata`
        );
      }
    }
    for (const trackedPath of trackedPaths) {
      if (
        trackedPath !== '.claude/skills' &&
        (trackedPath.startsWith('.claude/skills/') ||
          /(?:^|\/)\.claude\/skills\//.test(trackedPath)) &&
        !isProjectSkillAdapter(trackedPath)
      ) {
        violations.push(`${trackedPath} is an independently authored Claude skill`);
      }
      if (/(?:^|\/)\.skills\//.test(trackedPath)) {
        violations.push(`${trackedPath} is outside the canonical .agents/skills tree`);
      }
      if (
        trackedPath === 'tests/structural/repo-invariants.test.mjs' ||
        !/\.(?:md|mjs|ts|json)$/.test(trackedPath) ||
        !existsSync(path.join(repoRoot, trackedPath))
      ) {
        continue;
      }
      const lines = readFileSync(path.join(repoRoot, trackedPath), 'utf8').split('\n');
      for (const [index, line] of lines.entries()) {
        if (
          line.includes('.claude/skills/') &&
          !line.includes('https://') &&
          !projectSkillDocs.has(trackedPath)
        ) {
          violations.push(
            `${trackedPath}:${index + 1} references .claude/skills/ instead of .agents/skills/`
          );
        }
      }
    }

    assertNoViolations(
      violations,
      'Built-in Skills must be authored once under .agents. Project Skill adapters must point to project-owned skills/.',
      'AGENTS.md -> Working In This Repository'
    );
  });

  it('exposes only the unified dogsled bin across workspace packages', () => {
    const workspacePackages = listWorkspacePackages();
    deepStrictEqual(
      workspacePackages
        .filter((pkg) => pkg.packageJson.bin !== undefined)
        .map((pkg) => ({ name: pkg.name, bin: pkg.packageJson.bin })),
      [{ name: '@bobsled-inc/bobsled-core', bin: { dogsled: './bin/cli.mjs' } }]
    );
  });

  it('workspace CLI bin targets resolve to tracked files', () => {
    const violations = [];

    for (const pkg of listWorkspacePackages()) {
      const binConfig = pkg.packageJson.bin;
      if (!binConfig) {
        continue;
      }

      const targets =
        typeof binConfig === 'string'
          ? [binConfig]
          : Object.values(binConfig).filter((value) => typeof value === 'string');

      for (const target of targets) {
        const normalizedTarget = target.replaceAll('\\', '/');
        const targetPath = path.join(pkg.dir, target);
        if (/^(?:\.\/)?dist\//.test(normalizedTarget)) {
          violations.push(
            `${pkg.name} bin target "${target}" points into dist/; use a committed wrapper instead of generated build output`
          );
          continue;
        }

        if (!existsSync(targetPath)) {
          violations.push(`${pkg.name} bin target "${target}" does not exist in the checkout`);
        }
      }
    }

    assertNoViolations(
      violations,
      'Workspace CLI bins must exist in a fresh checkout so pnpm can wire them before any build runs.',
      'docs/getting-started.md -> Quickstart'
    );
  });
});

describe('publish hygiene', () => {
  const workspacePackages = listWorkspacePackages();
  const publishablePackages = listWorkspacePackages().filter(
    (pkg) => pkg.packageJson.private !== true
  );

  it('declares a resolvable DuckDB peer version', () => {
    const connections = workspacePackages.find((pkg) => pkg.name === '@bobsled-inc/connections');

    deepStrictEqual(
      connections?.packageJson.peerDependencies?.['@duckdb/node-api'],
      '^1.4.4-r.3',
      'the DuckDB peer range must include the prerelease-form version used by the workspace'
    );
  });

  it('requires a Snowflake driver that supports safe logging and connection query tags', () => {
    const connections = workspacePackages.find((pkg) => pkg.name === '@bobsled-inc/connections');

    deepStrictEqual(
      connections?.packageJson.peerDependencies?.['snowflake-sdk'],
      '>=3.4.0',
      'the Snowflake peer range must include the logging fixes and queryTag connection option'
    );
  });

  it('publishable packages declare complete metadata and reviewed npm settings', () => {
    const violations = [];

    if (
      publishablePackages.length !== 1 ||
      publishablePackages[0]?.name !== '@bobsled-inc/bobsled-core'
    ) {
      violations.push(
        'expected @bobsled-inc/bobsled-core to be the one publishable package under packages/'
      );
    }

    for (const pkg of publishablePackages) {
      const manifest = pkg.packageJson;
      if (typeof manifest.description !== 'string' || manifest.description.trim().length === 0) {
        violations.push(`${pkg.name} is missing a non-empty description`);
      }
      if (manifest.license !== 'Apache-2.0') {
        violations.push(`${pkg.name} license must be "Apache-2.0"`);
      }
      deepStrictEqual(
        manifest.publishConfig?.access,
        'restricted',
        'Review package access and this assertion together before changing publication policy.'
      );
      match(
        manifest.version,
        /^0\.(?:[1-9]\d*)\.(?:0|[1-9]\d*)(?:-preview\.(?:0|[1-9]\d*))?$/,
        'Releases follow the bootstrapped 0.1.0: a stable 0.x.y at or above 0.1.0, or a 0.x.y-preview.N.'
      );
      deepStrictEqual(
        manifest.publishConfig,
        {
          access: manifest.publishConfig.access,
          registry: 'https://registry.npmjs.org/',
        },
        `${pkg.name} must use an explicit access policy at npmjs.org`
      );
      deepStrictEqual(
        manifest.repository,
        {
          type: 'git',
          url: 'git+https://github.com/bobsled-inc/dogsled-core.git',
          directory: `packages/${pkg.shortName}`,
        },
        `${pkg.name} must identify its source directory in dogsled`
      );
      if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
        violations.push(`${pkg.name} must declare a non-empty files[] allowlist`);
        continue;
      }

      for (const requiredFile of ['README.md', 'LICENSE', 'NOTICE']) {
        if (!manifest.files.includes(requiredFile)) {
          violations.push(`${pkg.name} files[] must include ${requiredFile}`);
        }
        if (!existsSync(path.join(pkg.dir, requiredFile))) {
          violations.push(`${pkg.name} is missing ${requiredFile}`);
        }
      }

      if (
        manifest.files.some((entry) =>
          ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'].includes(entry.replace(/^\.\//, ''))
        )
      ) {
        violations.push(`${pkg.name} files[] must not publish agent instruction files`);
      }

      for (const entry of manifest.files) {
        if (typeof entry !== 'string' || /[*?[\]{}!]/.test(entry)) {
          continue;
        }
        const packagePath = path.join(pkg.dir, entry.replace(/^\.\//, ''));
        if (!existsSync(packagePath)) {
          violations.push(`${pkg.name} files[] entry "${entry}" does not exist`);
        }
      }
    }

    assertNoViolations(
      violations,
      'Publishable packages must ship only intentional, reviewable private artifacts with complete metadata.',
      'SECURITY.md -> Release and dependency security'
    );
  });

  it('keeps every supporting workspace private and out of npm publication', () => {
    const internalPackages = workspacePackages.filter(
      (pkg) => pkg.name !== '@bobsled-inc/bobsled-core'
    );
    const violations = [];

    if (internalPackages.length !== 15) {
      violations.push(`expected 15 internal packages, found ${internalPackages.length}`);
    }
    for (const pkg of internalPackages) {
      if (pkg.packageJson.private !== true) {
        violations.push(`${pkg.name} must set private: true`);
      }
      if (pkg.packageJson.publishConfig !== undefined) {
        violations.push(`${pkg.name} must not declare publishConfig`);
      }
      if (pkg.packageJson.version !== '0.20.224') {
        violations.push(`${pkg.name} must remain frozen at 0.20.224`);
      }
    }

    assertNoViolations(
      violations,
      'Supporting workspaces are implementation details embedded in the Dogsled package and must never publish independently.',
      'docs/releases.md -> Package model'
    );
  });

  it('bundles the complete internal workspace set into Dogsled', () => {
    const bobsledPackage = publishablePackages[0];
    const internalNames = workspacePackages
      .filter((pkg) => pkg.name !== '@bobsled-inc/bobsled-core')
      .map((pkg) => pkg.name)
      .sort();
    const bundled = [...(bobsledPackage?.packageJson.bundleDependencies ?? [])].sort();

    deepStrictEqual(
      bundled,
      [...internalNames, ...BUNDLED_EXTERNAL_PACKAGE_NAMES].sort(),
      'Dogsled bundleDependencies must contain every supporting workspace'
    );
    for (const name of internalNames) {
      deepStrictEqual(
        bobsledPackage.packageJson.dependencies?.[name],
        'workspace:*',
        `Dogsled must stage ${name} from the workspace`
      );
    }
  });

  // Test removed: 'keeps npm OIDC isolated from repository write access'
  // Reason: release.yml was deleted (not needed in this staging repo).
});

describe('package boundaries', () => {
  it('source files do not cross package boundaries via relative imports', () => {
    const packages = listWorkspacePackages();
    const violations = [];

    for (const pkg of packages) {
      const sourceFiles = listFilesRecursively(pkg.dir, (filePath) => filePath.endsWith('.ts'));
      for (const filePath of sourceFiles) {
        const content = readFileSync(filePath, 'utf8');
        const matches = content.matchAll(
          /(?:import|export)\s+(?:[^'"\n]+?\s+from\s+)?['"]([^'"]+)['"]|import\(['"]([^'"]+)['"]\)/g
        );

        for (const match of matches) {
          const specifier = match[1] ?? match[2];
          if (!specifier?.startsWith('.')) {
            continue;
          }

          const resolved = resolveImportTarget(filePath, specifier);
          if (!resolved) {
            continue;
          }

          const owner = packages.find((candidate) =>
            resolved.startsWith(`${candidate.dir}${path.sep}`)
          );
          if (owner && owner.dir !== pkg.dir) {
            violations.push(
              `${relativeToRepo(filePath)} imports ${specifier} which resolves into ${owner.name}; use the workspace package entrypoint instead`
            );
          }
        }
      }
    }

    assertNoViolations(
      violations,
      'Cross-package relative imports bypass package boundaries and break agent assumptions about ownership.',
      'AGENTS.md -> Configuration And Packages'
    );
  });
});

describe('protocol ownership', () => {
  it('protocol source stays free of workspace package dependencies', () => {
    const protocolSrc = path.join(repoRoot, 'packages', 'protocol', 'src');
    const violations = collectPatternViolations({
      fileFilter: (filePath) => {
        return filePath.startsWith(protocolSrc) && filePath.endsWith('.ts');
      },
      messageForMatch: ({ relativePath }) =>
        `${relativePath} imports another workspace package; @bobsled-inc/protocol must stay zero-dependency`,
      patterns: [
        /(?:import|export)\s+(?:[^'"\n]+?\s+from\s+)?['"]@bobsled-inc\//,
        /import\(['"]@bobsled-inc\//,
      ],
      stopAfterFirstMatchPerFile: true,
    });

    assertNoViolations(
      violations,
      'The protocol package must remain a pure contract layer so parser centralization cannot pull in runtime dependencies.',
      'Keep protocol contracts independent of runtime packages.'
    );
  });

  it('source files use named protocol version constants instead of raw _v literals', () => {
    const violations = collectPatternViolations({
      fileFilter: (filePath) => {
        return filePath.endsWith('.ts') && filePath.includes(`${path.sep}src${path.sep}`);
      },
      messageForMatch: ({ relativePath }) =>
        `${relativePath} hardcodes "_v: 1"; use PROTOCOL_VERSION or a summary version constant instead`,
      patterns: [/(?:['"]_v['"]|_v)\s*:\s*1\b/],
      stopAfterFirstMatchPerFile: true,
    });

    assertNoViolations(
      violations,
      'Source code must use named version constants so protocol bumps happen in one place and drift is caught structurally.',
      'Import named protocol version constants from the protocol package.'
    );
  });
});

describe('runtime hygiene', () => {
  // Files known to contain machine-generated content (baked from YAML
  // catalogs or markdown skill bodies). Their content can legitimately
  // include strings like `process.exit()` as guidance prose. Listed as
  // repo-relative paths so the exemption can't accidentally cover any
  // future handwritten file named `generated-data.ts`.
  const RUNTIME_HYGIENE_EXEMPT_PATHS = new Set([
    'packages/integrations/src/catalog/generated-data.ts',
    'packages/skills/src/generated-data.ts',
  ]);

  function isRuntimeHygieneCandidate(filePath) {
    if (!filePath.endsWith('.ts')) return false;
    return !RUNTIME_HYGIENE_EXEMPT_PATHS.has(relativeToRepo(filePath));
  }

  it('source files do not call console.* directly', () => {
    const violations = [];
    for (const pkg of listWorkspacePackages()) {
      const sourceFiles = listFilesRecursively(
        path.join(pkg.dir, 'src'),
        isRuntimeHygieneCandidate
      );

      for (const filePath of sourceFiles) {
        const content = readFileSync(filePath, 'utf8');
        if (/\bconsole\.(log|error|warn|info)\s*\(/.test(content)) {
          violations.push(`${relativeToRepo(filePath)} calls console.* directly`);
        }
      }
    }

    assertNoViolations(
      violations,
      'CLI and runtime code must not bypass the formatter layer with console.* calls.',
      'AGENTS.md -> Code Standards'
    );
  });

  it('source files do not call process.exit()', () => {
    const violations = [];
    for (const pkg of listWorkspacePackages()) {
      const sourceFiles = listFilesRecursively(
        path.join(pkg.dir, 'src'),
        isRuntimeHygieneCandidate
      );

      for (const filePath of sourceFiles) {
        const content = readFileSync(filePath, 'utf8');
        if (/\bprocess\.exit\s*\(/.test(content)) {
          violations.push(`${relativeToRepo(filePath)} calls process.exit()`);
        }
      }
    }

    assertNoViolations(
      violations,
      'Source code must signal failure through process.exitCode so cleanup and tests still run.',
      'AGENTS.md -> Code Standards'
    );
  });
});

describe('module boundaries', () => {
  it('extractor framework/ does not import from runtime/ or commands/', () => {
    const packages = listWorkspacePackages();
    const extractor = packages.find((p) => p.name === '@bobsled-inc/extractor');
    if (!extractor) return;

    const frameworkDir = path.join(extractor.dir, 'src', 'framework');
    if (!existsSync(frameworkDir)) return;

    const violations = [];
    const frameworkFiles = listFilesRecursively(frameworkDir, (f) => f.endsWith('.ts'));

    for (const filePath of frameworkFiles) {
      const content = readFileSync(filePath, 'utf8');
      const matches = content.matchAll(
        /(?:import|export)\s+(?:[^'"\n]+?\s+from\s+)?['"]([^'"]+)['"]|import\(['"]([^'"]+)['"]\)/g
      );

      for (const match of matches) {
        const specifier = match[1] ?? match[2];
        if (!specifier?.startsWith('.')) continue;

        const resolved = resolveImportTarget(filePath, specifier);
        if (!resolved) continue;

        const runtimeDir = path.join(extractor.dir, 'src', 'runtime');
        const commandsDir = path.join(extractor.dir, 'src', 'commands');
        if (
          resolved.startsWith(`${runtimeDir}${path.sep}`) ||
          resolved.startsWith(`${commandsDir}${path.sep}`)
        ) {
          violations.push(
            `${relativeToRepo(filePath)} imports ${specifier} which crosses into runtime/commands layer`
          );
        }
      }
    }

    assertNoViolations(
      violations,
      'The framework layer (schemas) must not import from the runtime or commands layers.',
      'packages/extractor/AGENTS.md -> Security Invariants'
    );
  });
});

describe('CLI identity hygiene', () => {
  it('active tracked files do not reintroduce the legacy bx identity', () => {
    const allowlistedPaths = new Set([
      'packages/extractor/tests/integration/helpers/fake-server.ts',
      'tests/structural/repo-invariants.test.mjs',
      // pnpm-lock.yaml is a generated file whose base64 integrity hashes can
      // randomly contain "bx" at word boundaries. Source hygiene does not apply.
      'pnpm-lock.yaml',
    ]);
    const candidateExtensions = new Set([
      '.ts',
      '.js',
      '.mjs',
      '.cjs',
      '.json',
      '.md',
      '.sh',
      '.yml',
      '.yaml',
      '.txt',
    ]);
    const forbiddenPatterns = [
      /@bobsled\/bx\b/,
      /\bpackages\/bx\b/,
      /\bBX_DIR\b/,
      /\bAPP_PUBLIC_BX\b/,
      /\bbx\b/,
    ];

    const violations = collectPatternViolations({
      allowlistedPaths,
      fileFilter: (filePath) => {
        const relativePath = relativeToRepo(filePath);
        if (relativePath.startsWith('.context/')) {
          return false;
        }

        return candidateExtensions.has(path.extname(filePath));
      },
      messageForMatch: ({ pattern, relativePath }) =>
        `${relativePath} contains legacy BX identity matching ${pattern.source}`,
      patterns: forbiddenPatterns,
      stopAfterFirstMatchPerFile: true,
      trackedOnly: true,
    });

    assertNoViolations(
      violations,
      'Active repo surfaces must not refer to the legacy bx identity except for the explicit fixture allowlist.',
      'packages/bobsled-core/AGENTS.md -> Two Command Strategies'
    );
  });
});

describe('secret leak detection', () => {
  it('YAML and JSON fixture files do not contain hardcoded secrets', () => {
    const secretPatterns = [
      /\bsk_live_[A-Za-z0-9]{10,}/,
      /\bsk-[A-Za-z0-9]{20,}/,
      /\bghp_[A-Za-z0-9]{30,}/,
      /\bgho_[A-Za-z0-9]{30,}/,
      /\bglpat-[A-Za-z0-9]{20,}/,
      /\bxoxb-[A-Za-z0-9-]{20,}/,
      /\bxoxp-[A-Za-z0-9-]{20,}/,
      /\bAKIA[A-Z0-9]{12,}/,
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
      /\b(?:postgres|mysql|mongodb):\/\/[^/\s:@]+:[^@\s]+@/i,
    ];
    const secretFileAllowlist = new Set([]);

    const violations = collectPatternViolations({
      allowlistedPaths: secretFileAllowlist,
      fileFilter: (filePath) => {
        if (filePath.endsWith('.yml') || filePath.endsWith('.yaml')) {
          return true;
        }

        return filePath.endsWith('.json') && filePath.split(path.sep).includes('fixtures');
      },
      messageForMatch: ({ pattern, relativePath }) =>
        `${relativePath} contains a potential hardcoded secret matching ${pattern.source}`,
      patterns: secretPatterns,
    });

    assertNoViolations(
      violations,
      'Config and fixture files must not contain hardcoded secrets. Use env var references ($ENV_VAR) instead.',
      'AGENTS.md -> Working In Public'
    );
  });

  it('repo does not contain checked-in .env files', () => {
    const envFiles = listTrackedFiles((filePath) => {
      const base = path.basename(filePath);
      return base === '.env' || (/^\.env\./.test(base) && !/^\.env\.(example|sample)$/.test(base));
    }).map((filePath) => relativeToRepo(filePath));

    if (envFiles.length > 0) {
      throw new Error(
        `Checked-in .env files are not allowed:\n${envFiles.map((filePath) => `- ${filePath}`).join('\n')}`
      );
    }
  });
});

describe('GitHub Actions security', () => {
  const workflowsDir = path.join(repoRoot, '.github', 'workflows');
  const usesPattern = /^\s*(?:-\s+)?uses:\s+([^@\s]+)@([^\s#]+)/gm;
  const compositeActionsDir = path.join(repoRoot, 'actions');

  it('checks actions after a step name as well as the first step key', () => {
    const fixture =
      '- name: Named action\n  uses: actions/checkout@main\n- uses: actions/setup-node@v6\n';
    deepStrictEqual(
      [...fixture.matchAll(usesPattern)].map((match) => match[2]),
      ['main', 'v6']
    );
  });

  it('workflows use least privilege and immutable third-party action references', () => {
    const violations = [];
    const workflowFiles = listFilesRecursively(workflowsDir, (filePath) =>
      /\.ya?ml$/.test(filePath)
    );

    for (const workflowPath of workflowFiles) {
      const relativePath = relativeToRepo(workflowPath);
      const content = readFileSync(workflowPath, 'utf8');

      if (
        /(^|\n)\s*pull_request_target\s*:/.test(content) &&
        // Metadata-only: no checkout; independent unit tests enforce safety properties.
        relativePath !== '.github/workflows/contribution-policy.yml'
      ) {
        violations.push(`${relativePath} uses pull_request_target`);
      }
      if (!/(^|\n)permissions:\s*\n\s+contents:\s*read\s*(?:\n|$)/.test(content)) {
        violations.push(`${relativePath} must declare top-level contents: read permissions`);
      }

      for (const match of content.matchAll(usesPattern)) {
        const action = match[1];
        const ref = match[2];
        if (action?.startsWith('./')) {
          continue;
        }
        if (!ref || !/^[a-f0-9]{40}$/.test(ref)) {
          violations.push(`${relativePath} action ${action}@${ref ?? ''} is not SHA-pinned`);
        }
      }
    }

    assertNoViolations(
      violations,
      'GitHub Actions workflows must be least-privilege and pin third-party code immutably.',
      'SECURITY.md -> Scope'
    );
  });

  it('composite actions pin every nested action to an immutable commit', () => {
    const violations = [];
    const actionFiles = existsSync(compositeActionsDir)
      ? listFilesRecursively(compositeActionsDir, (filePath) =>
          /(?:^|\/)action\.ya?ml$/.test(filePath)
        )
      : [];

    for (const actionPath of actionFiles) {
      const relativePath = relativeToRepo(actionPath);
      const content = readFileSync(actionPath, 'utf8');
      for (const match of content.matchAll(/^\s*uses:\s+([^@\s]+)@([^\s#]+)/gm)) {
        const action = match[1];
        const ref = match[2];
        if (action?.startsWith('./')) {
          continue;
        }
        if (!ref || !/^[a-f0-9]{40}$/.test(ref)) {
          violations.push(`${relativePath} nested action ${action}@${ref ?? ''} is not SHA-pinned`);
        }
      }
    }

    assertNoViolations(
      violations,
      'Composite actions must pin every nested third-party action to an immutable commit.',
      'SECURITY.md -> Scope'
    );
  });

  it('checkout does not persist write-capable credentials', () => {
    const violations = [];
    const workflowFiles = listFilesRecursively(workflowsDir, (filePath) =>
      /\.ya?ml$/.test(filePath)
    );

    for (const workflowPath of workflowFiles) {
      const content = readFileSync(workflowPath, 'utf8');
      const checkoutBlocks = [
        ...content.matchAll(/uses:\s+actions\/checkout@[^\n]+\n((?:\s{8,}.+\n?)*)/g),
      ];
      for (const block of checkoutBlocks) {
        if (!/persist-credentials:\s*false/.test(block[1] ?? '')) {
          violations.push(
            `${relativeToRepo(workflowPath)} checkout step must set persist-credentials: false`
          );
        }
      }
    }

    assertNoViolations(
      violations,
      'CI checkouts must not retain GitHub credentials after source retrieval.',
      'SECURITY.md -> Scope'
    );
  });
});

describe('release and dependency policy guardrails', () => {
  const templatePath = path.join(repoRoot, '.github', 'pull_request_template.md');

  it('delays every package update for one week', () => {
    const workspace = readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
    match(workspace, /^minimumReleaseAge:\s*10080$/m);

    const dependabot = readFileSync(path.join(repoRoot, '.github', 'dependabot.yml'), 'utf8');
    deepStrictEqual(
      [...dependabot.matchAll(/open-pull-requests-limit:\s*(\d+)/g)].map((match) => match[1]),
      ['6', '1']
    );
    deepStrictEqual(
      [...dependabot.matchAll(/default-days:\s*(\d+)/g)].map((match) => match[1]),
      ['7', '7']
    );
  });

  it('runs Dependabot version updates on Mondays at 06:00 UTC', () => {
    const dependabot = parseYaml(
      readFileSync(path.join(repoRoot, '.github', 'dependabot.yml'), 'utf8')
    );
    deepStrictEqual(
      dependabot.updates.map((entry) => [entry['package-ecosystem'], entry.schedule]),
      ['npm', 'github-actions'].map((ecosystem) => [
        ecosystem,
        { interval: 'weekly', day: 'monday', time: '06:00', timezone: 'Etc/UTC' },
      ])
    );
  });

  it('keeps npm updates in ordered reviewable groups', () => {
    const dependabot = parseYaml(
      readFileSync(path.join(repoRoot, '.github', 'dependabot.yml'), 'utf8')
    );
    const npm = dependabot.updates.find((entry) => entry['package-ecosystem'] === 'npm');
    deepStrictEqual(Object.keys(npm.groups), [
      'ai',
      'data-and-cloud',
      'frontend',
      'lint-and-security',
      'build-and-types',
      'runtime-other',
    ]);
    for (const group of Object.values(npm.groups)) {
      deepStrictEqual(group['update-types'], ['minor', 'patch']);
    }
    deepStrictEqual(npm.groups['runtime-other'].patterns, ['*']);
  });

  it('limits release-age exemptions to documented exact versions until their removal date', () => {
    const workspace = parseYaml(readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'));
    const exemptions = parseReleaseAgeExemptions(workspace.minimumReleaseAgeExclude).map(
      ({ name, version }) => `${name}@${version}`
    );
    const guide = readFileSync(path.join(repoRoot, 'docs', 'dependency-security.md'), 'utf8');
    const section = guide.split('## Security-fix release-age exemptions\n')[1]?.split('\n## ')[0];
    ok(section, 'docs/dependency-security.md must list the release-age exemptions');
    const removeAfter = new Map();
    for (const row of section.split('\n').filter((line) => /^\| `/.test(line))) {
      const [packages, , , removal] = row
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim());
      ok(!Number.isNaN(Date.parse(removal)), `Invalid removal date in: ${row}`);
      for (const [, spec] of packages.matchAll(/`([^`]+)`/g)) removeAfter.set(spec, removal);
    }
    deepStrictEqual([...removeAfter.keys()].sort(), [...exemptions].sort());
    for (const [spec, removal] of removeAfter) {
      const status = expiryStatus(removal, EXEMPTION_GRACE_DAYS);
      if (status === 'warning') {
        console.warn(
          `WARNING: ${spec} met the release age on ${removal}; ` +
            `remove its exemption within ${EXEMPTION_GRACE_DAYS} days.`
        );
      }
      ok(
        status !== 'expired',
        `${spec} met the release age on ${removal} and the ${EXEMPTION_GRACE_DAYS}-day ` +
          `grace period has passed; remove its exemption.`
      );
    }
  });

  it('requires release environment approval before pushing an immutable tag', () => {
    const workflow = readFileSync(path.join(repoRoot, '.github/workflows/release.yml'), 'utf8');
    match(workflow, /^  release-checks-ok:\n/m);
    const approveJob = workflow.split('\n  approve:\n')[1].split('\n  tag:\n')[0];
    match(approveJob, /^    environment: release-approval$/m);
    match(approveJob, /release-checks-ok/);
    const tagJob = workflow.split('\n  tag:\n')[1].split('\n  publish:\n')[0];
    match(tagJob, /^    environment: release-tag$/m);
    match(tagJob, /github\.ref == 'refs\/heads\/main'/);
    match(tagJob, /git -c core.hooksPath=\/dev\/null push origin/);
  });

  it('deploys only the Dogsled production graph for release artifacts', () => {
    const stageScript = readFileSync(
      path.join(repoRoot, 'scripts/release/stage-package.mjs'),
      'utf8'
    );
    const archiveScript = readFileSync(
      path.join(repoRoot, 'packages/bobsled-core/scripts/pack.sh'),
      'utf8'
    );

    match(stageScript, /'--config\.inject-workspace-packages=true'/);
    doesNotMatch(stageScript, /'--legacy'/);
    doesNotMatch(stageScript, /'--config\.auto-install-peers=false'/);

    match(
      archiveScript,
      /pnpm --config\.inject-workspace-packages=true deploy --filter @bobsled-inc\/dogsled --prod/
    );
    doesNotMatch(archiveScript, /pnpm deploy --legacy/);
  });

  function readFlatYamlMapping(filePath, sectionName) {
    const content = readFileSync(filePath, 'utf8');
    const escapedName = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const section = content.match(
      new RegExp(`^${escapedName}:\\n((?:  (?:#.*|[^\\n]+)\\n?)*)`, 'm')
    )?.[1];
    if (section === undefined) {
      throw new Error(`${relativeToRepo(filePath)} is missing ${sectionName}:`);
    }

    const mapping = {};
    for (const line of section.split('\n')) {
      if (line.trim() === '' || line.trimStart().startsWith('#')) {
        continue;
      }
      const match = line.match(/^  ('[^']+'|[^:]+):\s*(\S.*)$/);
      if (!match) {
        throw new Error(
          `${relativeToRepo(filePath)} ${sectionName}: must remain a flat scalar mapping`
        );
      }
      const key = match[1].replace(/^'|'$/g, '');
      const value = match[2].replace(/^'|'$/g, '');
      mapping[key] = value;
    }
    return mapping;
  }

  it('keeps retired private release automation absent from the OSS tree', () => {
    const rootPackage = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const forbiddenDependencies = [
      'auto',
      '@auto-it/conventional-commits',
      '@auto-it/first-time-contributor',
      '@auto-it/pr-body-labels',
      '@auto-it/released',
    ];
    const violations = [];

    for (const relativePath of ['.autorc', 'scripts/auto-plugins', 'tests/unit/auto-plugins']) {
      if (existsSync(path.join(repoRoot, relativePath))) {
        violations.push(`${relativePath} re-enables the retired Auto/GAR release path`);
      }
    }

    for (const name of forbiddenDependencies) {
      if (rootPackage.dependencies?.[name] || rootPackage.devDependencies?.[name]) {
        violations.push(`root dependency ${name} belongs to the retired Auto release path`);
      }
    }

    assertNoViolations(
      violations,
      'The repository must not retain retired GAR or Auto publishing controls.',
      'SECURITY.md -> Release and dependency security'
    );
  });

  it('uses one canonical override map and keeps the lockfile projection in sync', () => {
    const rootPackage = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    if (rootPackage.pnpm?.overrides !== undefined) {
      throw new Error(
        'package.json must not duplicate pnpm-workspace.yaml overrides; keep one canonical map.'
      );
    }

    const workspaceOverrides = readFlatYamlMapping(
      path.join(repoRoot, 'pnpm-workspace.yaml'),
      'overrides'
    );
    const lockfileOverrides = readFlatYamlMapping(
      path.join(repoRoot, 'pnpm-lock.yaml'),
      'overrides'
    );
    deepStrictEqual(lockfileOverrides, workspaceOverrides);
  });

  it('keeps SQLite setup on the lockfile-pinned local installer', () => {
    const rootPackage = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const setup = rootPackage.scripts?.['setup:sqlite'] ?? '';

    match(setup, /\.\/node_modules\/\.bin\/prebuild-install/);
    if (/\bnpx\b|\bnode-gyp\b/.test(setup)) {
      throw new Error(
        'setup:sqlite must not fetch an ambient npx/node-gyp fallback; use the locked local installer.'
      );
    }
  });

  it('exposes dependency auditing as an explicit networked security gate', () => {
    const rootPackage = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    deepStrictEqual(rootPackage.scripts?.['security:audit'], 'audit-ci --config ./audit-ci.json');
    deepStrictEqual(rootPackage.devDependencies?.['audit-ci'], 'catalog:security');

    const auditConfig = JSON.parse(readFileSync(path.join(repoRoot, 'audit-ci.json'), 'utf8'));
    deepStrictEqual(auditConfig.high, true);
    for (const entry of auditConfig.allowlist) {
      deepStrictEqual(Object.keys(entry).length, 1);
      const [advisoryPath, details] = Object.entries(entry)[0];
      match(advisoryPath, /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}\|[^*]+>[^*]+$/);
      ok(details.notes.length > 40, 'Audit exceptions need package reachability evidence.');
      ok(Number.isFinite(Date.parse(details.expiry)), 'Audit exceptions need a review deadline.');
    }

    const workflow = readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    match(workflow, /schedule:\s*\n\s*- cron:/);
    match(workflow, /github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
    match(workflow, /github\.event_name == 'schedule'/);
    match(workflow, /github\.event_name == 'workflow_dispatch'/);
    match(
      workflow,
      /github\.event_name == 'pull_request' && steps\.dependency-changes\.outputs\.changed == 'true'/
    );
    match(workflow, /run: pnpm security:audit/);
  });

  it('keeps the local security review deterministic and raw evidence private', () => {
    const rootPackage = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const expectedScripts = {
      'security:fast': [
        'node ./scripts/security/secretlint-tracked.mjs',
        'node ./scripts/security/fast.mjs',
        rootPackage.scripts?.['guard:old-names'],
        'node ./scripts/guards/privacy.mjs',
        'vitest run --config ./vitest.security.config.mjs',
      ]
        .filter(Boolean)
        .join(' && '),
      'security:collect': 'node ./scripts/security/collect.mjs',
      'security:normalize': 'node ./scripts/security/normalize.mjs',
      'security:verify': 'node ./scripts/security/verify.mjs',
      'security:packet': 'node ./scripts/security/packet.mjs',
      'security:release': 'node ./scripts/security/release.mjs',
    };
    for (const [name, command] of Object.entries(expectedScripts)) {
      deepStrictEqual(rootPackage.scripts?.[name], command);
    }

    const gitignore = readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
    match(gitignore, /^\.security-review\/$/m);
    const workflow = readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    match(workflow, /run: pnpm security:fast/);
    if (/upload-artifact[\s\S]{0,500}\.security-review/.test(workflow)) {
      throw new Error('CI must never upload raw .security-review evidence.');
    }

    for (const requiredPath of [
      'PRIVACY.md',
      '.agents/skills/open-source-security-review/SKILL.md',
      'scripts/security/finding.schema.json',
      'vitest.security.config.mjs',
    ]) {
      if (!existsSync(path.join(repoRoot, requiredPath))) {
        throw new Error(`Missing local security-review artifact ${requiredPath}`);
      }
    }
  });

  it('PR template exposes exactly the supported change-type boxes', () => {
    const content = readFileSync(templatePath, 'utf8');
    // Scope to the Change Type section only so test-plan checkboxes don't false-positive.
    const changeTypeSection = content.match(/## Change Type\n([\s\S]*?)(?=\n## |$)/)?.[1] ?? '';
    const checkboxLabels = [
      ...changeTypeSection.matchAll(/^[ \t]*- \[[ xX]\][ \t]*`([^`]+)`/gm),
    ].map((match) => match[1]);
    const expected = [
      'patch',
      'minor',
      'major',
      'internal',
      'documentation',
      'tests',
      'dependencies',
      'performance',
      'skip-release',
    ];
    const missing = expected.filter((label) => !checkboxLabels.includes(label));
    const extra = checkboxLabels.filter((label) => !expected.includes(label));

    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        [
          missing.length > 0
            ? `.github/pull_request_template.md is missing change-type checkboxes: ${missing.join(', ')}.`
            : null,
          extra.length > 0
            ? `.github/pull_request_template.md has unsupported change-type checkboxes: ${extra.join(', ')}.`
            : null,
        ]
          .filter(Boolean)
          .join('\n')
      );
    }
  });

  it('PR template does not pre-check any change-type box', () => {
    const content = readFileSync(templatePath, 'utf8');
    // Scope to the Change Type section only.
    const changeTypeSection = content.match(/## Change Type\n([\s\S]*?)(?=\n## |$)/)?.[1] ?? '';
    const checked = [...changeTypeSection.matchAll(/^[ \t]*-[ \t]*\[[xX]\][ \t]*`([^`]+)`/gm)].map(
      (match) => match[1]
    );
    if (checked.length > 0) {
      throw new Error(
        `.github/pull_request_template.md should not pre-check change-type boxes; found: ${checked.join(', ')}.`
      );
    }
  });
});

describe('workflow guardrails', () => {
  it('CI covers every precommit stage and keeps fork jobs read-only', () => {
    const source = readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    const workflow = parseYaml(source);
    deepStrictEqual(Object.keys(workflow.jobs), [
      'checks',
      'unit',
      'showcases',
      'showcase-results',
      'outsider',
      'ci-ok',
    ]);
    deepStrictEqual(workflow.jobs['ci-ok'].needs, [
      'checks',
      'unit',
      'showcases',
      'showcase-results',
      'outsider',
    ]);
    deepStrictEqual(workflow.jobs.showcases.strategy.matrix.leg, ['audit', 'core']);
    deepStrictEqual(workflow.jobs['showcase-results'].needs, 'showcases');
    deepStrictEqual(workflow.jobs['ci-ok'].if, 'always()');
    deepStrictEqual(workflow.jobs['ci-ok'].steps[0], {
      name: 'Require every check',
      env: {
        CHECKS: '${{ needs.checks.result }}',
        UNIT: '${{ needs.unit.result }}',
        SHOWCASE_RESULTS: '${{ needs.showcase-results.result }}',
        SHOWCASES: '${{ needs.showcases.result }}',
        OUTSIDER: '${{ needs.outsider.result }}',
      },
      run: 'test "$CHECKS" = success && test "$UNIT" = success && test "$SHOWCASE_RESULTS" = success && test "$SHOWCASES" = success && test "$OUTSIDER" = success',
    });
    const upload = workflow.jobs.showcases.steps.find((step) =>
      step.uses?.startsWith('actions/upload-artifact@')
    );
    deepStrictEqual(upload.with.overwrite, true);
    const scripts = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts;
    const stages = scripts.precommit.split(' && ');
    const commands = Object.values(workflow.jobs).flatMap((job) =>
      job.steps.map((step) => step.run).filter(Boolean)
    );
    deepStrictEqual(
      commands.filter((command) => stages.includes(command)),
      stages.filter((stage) => stage !== 'pnpm test:unit')
    );
    deepStrictEqual(
      stages.filter((stage) => !commands.includes(stage)),
      ['pnpm test:unit']
    );
    ok(
      workflow.jobs.unit.steps.some(
        (step) =>
          step.run === 'pnpm "test:unit:ci:$UNIT_LEG"' && step.env.UNIT_LEG === '${{ matrix.leg }}'
      )
    );
    ok(
      commands.includes(
        'pnpm e2e -- --leg "$SHOWCASE_LEG" --results "test-results/showcases/$SHOWCASE_LEG.json"'
      )
    );
    ok(commands.includes('node scripts/e2e/run.mjs --aggregate test-results/showcases'));
    ok(commands.includes('pnpm e2e:outsider'));
    for (const file of ['ci.yml']) {
      const source = readFileSync(path.join(repoRoot, '.github/workflows', file), 'utf8');
      const workflow = parseYaml(source);
      deepStrictEqual(workflow.permissions, { contents: 'read' });
      deepStrictEqual(
        workflow.concurrency.group,
        "${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.sha }}"
      );
      ok(workflow.on.pull_request);
      deepStrictEqual(
        workflow.concurrency['cancel-in-progress'],
        "${{ github.event_name == 'pull_request' }}"
      );
      doesNotMatch(source, /pull_request_target|secrets[.[]|actions\/cache@/);
      for (const job of Object.values(workflow.jobs)) {
        if (job.permissions !== undefined) deepStrictEqual(job.permissions, { contents: 'read' });
        for (const step of job.steps) {
          if (step.uses?.startsWith('actions/checkout@'))
            deepStrictEqual(step.with['persist-credentials'], false);
        }
      }
    }
  });

  it('unit matrix partitions every workspace package exactly once, including future packages', () => {
    const scripts = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts;
    const ci = parseYaml(readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8'));
    const legs = ['model', 'graph', 'dogsled', 'rest'];
    deepStrictEqual(ci.jobs.unit.strategy.matrix.leg, legs);
    deepStrictEqual(ci.jobs.unit.strategy['fail-fast'], false);
    const actual = [];
    const explicit = [];
    for (const leg of legs) {
      const script = scripts[`test:unit:ci:${leg}`];
      match(
        script,
        /^pnpm_config_verify_deps_before_run=false turbo run test:unit --log-order=stream --concurrency=100% /
      );
      const filters = [...script.matchAll(/--filter='([^']+)'/g)].map((match) => match[1]);
      ok(filters.length > 0);
      if (leg === 'rest')
        deepStrictEqual(
          filters,
          explicit.map((name) => `!${name}`)
        );
      else {
        ok(filters.every((name) => !name.startsWith('!') && !/[.*{}[\]]/.test(name)));
        explicit.push(...filters);
      }
      const summary = JSON.parse(
        execFileSync(
          'pnpm',
          [
            'exec',
            'turbo',
            'run',
            'test:unit',
            '--dry=json',
            ...filters.map((filter) => `--filter=${filter}`),
          ],
          { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
        )
      );
      actual.push(
        ...summary.tasks.filter((task) => task.task === 'test:unit').map((task) => task.package)
      );
    }
    const workspace = parseYaml(readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'));
    deepStrictEqual(workspace.packages, ['packages/*', 'apps/*']);
    const expected = workspace.packages.flatMap((glob) => {
      const directory = path.join(repoRoot, glob.slice(0, -2));
      return readdirSync(directory).flatMap((name) => {
        const manifest = path.join(directory, name, 'package.json');
        return existsSync(manifest) ? [JSON.parse(readFileSync(manifest, 'utf8')).name] : [];
      });
    });
    deepStrictEqual(actual.sort(), expected.sort());
    match(scripts['test:unit:ci:rest'], /--filter='!@bobsled-inc\//);
  }, 30_000);

  it('CLI entry modules can be imported and built without parsing host arguments', () => {
    const entries = [
      'entity-graph/dist/cli.js',
      'model-spec/dist/index.js',
      'extractor/dist/index.js',
      'loader/dist/index.js',
    ];
    const script = `process.argv = ['node', process.cwd() + '/package.json', '--invalid-host-argument'];
for (const entry of ${JSON.stringify(entries)}) {
  const { buildProgram } = await import(new URL('./packages/' + entry, import.meta.url));
  const first = buildProgram();
  const second = buildProgram();
  if (first === second || !first.commands.length || first.helpInformation() !== second.helpInformation()) throw new Error('Invalid program factory');
}`;
    execFileSync('node', ['--input-type=module', '-e', script], { cwd: repoRoot, stdio: 'pipe' });
  });

  it('CLI reference is byte-identical in a wide interactive terminal', () => {
    const script = `Object.defineProperties(process.stdout, {
  isTTY: { value: true, configurable: true },
  columns: { value: 240, configurable: true },
});
process.argv = ['node', process.cwd() + '/scripts/docs/cli-reference.mjs', '--check'];
await import('./scripts/docs/cli-reference.mjs');`;
    const output = execFileSync('node', ['--input-type=module', '-e', script], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    match(output, /docs\/reference\/cli.md matches/);
  });

  it('CLI reference routing matches the runtime delegated subcommand lists', () => {
    const delegation = readFileSync(
      path.join(repoRoot, 'packages/bobsled-core/src/runtime/delegation.ts'),
      'utf8'
    );
    const table = delegation.match(/const GROUP_SUBCOMMANDS = \{([\s\S]*?)\} satisfies/)?.[1];
    ok(table);
    deepStrictEqual(
      [...table.matchAll(/^\s*(?:'([^']+)'|([a-z-]+)):\s*([A-Z_]+),?$/gm)].map((entry) => [
        entry[1] ?? entry[2],
        entry[3],
      ]),
      [
        ['embed', 'EMBED_SUBCOMMANDS'],
        ['extract', 'EXTRACT_SUBCOMMANDS'],
        ['load', 'LOAD_SUBCOMMANDS'],
        ['model', 'MODEL_SUBCOMMANDS'],
        ['entity-graph', 'ENTITY_GRAPH_SUBCOMMANDS'],
      ]
    );
    const script = `import assert from 'node:assert/strict';
const write = process.stdout.write;
process.stdout.write = () => true;
let delegatedCommand;
try {
  ({ delegatedCommand } = await import('./scripts/docs/cli-reference.mjs'));
} finally {
  process.stdout.write = write;
}
for (const [group, file, constant, entry] of [
  ['embed', 'embed', 'EMBED_SUBCOMMANDS', 'embedder/dist/index.js'],
  ['extract', 'extract', 'EXTRACT_SUBCOMMANDS', 'extractor/dist/index.js'],
  ['load', 'load', 'LOAD_SUBCOMMANDS', 'loader/dist/index.js'],
  ['model', 'model', 'MODEL_SUBCOMMANDS', 'model-spec/dist/index.js'],
  ['entity-graph', 'entity-graph', 'ENTITY_GRAPH_SUBCOMMANDS', 'entity-graph/dist/cli.js'],
  ['mcp', 'mcp', 'MCP_SUBCOMMANDS', 'extractor/dist/index.js'],
]) {
  const lists = await import('./packages/bobsled-core/src/groups/' + file + '.ts');
  const { buildProgram } = await import('./packages/' + entry);
  let program = buildProgram();
  if (group === 'mcp') program = program.commands.find((command) => command.name() === 'mcp');
  const shell = {};
  assert.equal(delegatedCommand([group], shell), shell);
  for (const name of lists[constant]) {
    const expected = program.commands.find((command) => command.name() === name || command.aliases().includes(name));
    assert.ok(expected, group + ' ' + name + ' must resolve in its delegated program');
    expected.configureHelp({ helpWidth: 80 });
    const actual = delegatedCommand([group, name], shell);
    assert.notEqual(actual, shell, group + ' ' + name + ' must delegate');
    assert.equal(actual.helpInformation(), expected.helpInformation(), group + ' ' + name);
  }
}
const shell = {};
assert.equal(delegatedCommand(['mcp', 'serve'], shell), shell);
const { buildProgram } = await import('./packages/entity-graph/dist/cli.js');
const receipts = buildProgram().commands.find((command) => command.name() === 'activate').commands.find((command) => command.name() === 'receipts');
receipts.configureHelp({ helpWidth: 80 });
assert.equal(delegatedCommand(['activate', 'receipts'], shell).helpInformation(), receipts.helpInformation());`;
    execFileSync('node', ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  });

  it('PR change-type validator accepts escaped markdown code spans from live PR bodies', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'dogsled-pr-change-type-'));
    const eventPath = path.join(tempDir, 'event.json');

    writeFileSync(
      eventPath,
      JSON.stringify({
        pull_request: {
          body: [
            '## Change Type',
            '',
            '- [x] \\`internal\\` - Internal',
            '- [ ] \\`patch\\` - Bug Fix',
            '',
            '## Release Notes',
            '',
            'Internal-only CI fix.',
          ].join('\n'),
        },
      })
    );

    try {
      const output = execFileSync('node', ['scripts/ci/validate-pr-change-type.mjs'], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, GITHUB_EVENT_PATH: eventPath },
      });

      if (!output.includes('Validated PR change type: internal')) {
        throw new Error(
          `scripts/ci/validate-pr-change-type.mjs did not validate escaped checkbox labels. Output:\n${output}`
        );
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('action packaging hygiene', () => {
  it('composite actions do not self-reference remote Dogsled actions', () => {
    const violations = collectPatternViolations({
      fileFilter: (filePath) => {
        return (
          filePath.startsWith(path.join(repoRoot, 'actions')) &&
          ['action.yml', 'action.yaml'].includes(path.basename(filePath))
        );
      },
      messageForMatch: ({ relativePath }) =>
        `${relativePath} references a remote Dogsled action instead of using local implementation steps`,
      patterns: [/bobsled-inc\/track\/actions\/[^\s'"]+@/],
      stopAfterFirstMatchPerFile: true,
    });

    assertNoViolations(
      violations,
      'Composite actions in this repo must stay self-contained so pinning a Dogsled action does not silently hop back to a different ref.',
      'AGENTS.md -> Protocol'
    );
  });

  it('does not retain the retired toolkit Actions', () => {
    for (const name of ['setup-track', 'track-action']) {
      ok(!existsSync(path.join(repoRoot, 'actions', name, 'action.yml')));
    }
  });
});
