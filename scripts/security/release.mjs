import { completeBundledSbom } from '../release/sbom.mjs';
import { createHash } from 'node:crypto';
import { auditPackedConsumers } from './consumer-audit.mjs';
import { smokePackedData } from '../release/packed-smoke.mjs';
import {
  checkThirdPartyNotices,
  checkPackedThirdPartyNotices,
} from '../release/third-party-notices.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listWorkspacePackages } from '../ci/shared.mjs';
import {
  BUNDLED_EXTERNAL_PACKAGE_NAMES,
  EXPECTED_INTERNAL_PACKAGE_COUNT,
  INTERNAL_PACKAGE_NAMES,
  BOBSLED_CORE_PACKAGE_NAME,
} from '../release/package-set.mjs';
import { stageBobsledPackage } from '../release/stage-package.mjs';
import {
  ensureDir,
  executablePath,
  parseArgs,
  repoRoot,
  reviewRoot,
  sha256File,
  writeJson,
} from './lib.mjs';
import { isForbiddenPackageEntry, packageImportSpecifiers } from './release-policy.mjs';

const DELEGATED_HELP_COMMANDS = ['extract', 'load', 'model', 'entity-graph', 'embed'];
const REQUIRED_ASSET_PREFIXES = [
  'package/node_modules/@bobsled-inc/integrations/sources/',
  'package/node_modules/@bobsled-inc/models/marts/',
  'package/node_modules/@bobsled-inc/skills/content/',
  'package/node_modules/@bobsled-inc/entity-graph/fixtures/b2b-company-master/',
  'package/examples/demo/',
  'package/examples/s3-documents-ingestion/',
  'package/cowork/bobsled-setup-plugin/',
];

function run(command, args, options) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

function recordFailure(violations, label, result) {
  if (result.status === 0) return false;
  const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
  violations.push(`${label} failed${detail ? `: ${detail}` : ''}`);
  return true;
}

const args = parseArgs();
const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).trim();
const publishable = listWorkspacePackages().filter((pkg) => pkg.packageJson.private !== true);

if (args.execute !== true) {
  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'deferred',
        message:
          'The npm artifact gate is intentionally deferred. Re-run with --execute from the immutable release-candidate commit.',
        commit,
        packageCount: publishable.length,
      },
      null,
      2
    )}\n`
  );
  process.exit(0);
}

if (publishable.length !== 1 || publishable[0].name !== BOBSLED_CORE_PACKAGE_NAME) {
  throw new Error(`Expected ${BOBSLED_CORE_PACKAGE_NAME} to be the one publishable package.`);
}
const [dogsled] = publishable;
const dirty = execFileSync('git', ['status', '--porcelain'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).trim();
if (dirty && args['allow-dirty'] !== true) {
  throw new Error(
    'security:release requires a clean immutable commit; use --allow-dirty only for tests.'
  );
}

const outputDir = ensureDir(
  args.out ? path.resolve(args.out) : path.join(reviewRoot, `release-${commit.slice(0, 12)}`)
);
const tarballDir = ensureDir(path.join(outputDir, 'tarballs'));
const inspectionDir = ensureDir(path.join(outputDir, 'inspection'));
const stageRoot = mkdtempSync(path.join(os.tmpdir(), 'bobsled-release-stage-'));
const scratch = mkdtempSync(path.join(os.tmpdir(), 'bobsled-release-smoke-'));
const violations = [];
const artifacts = [];
let sbomStatus = 'unavailable';
let sbomSha256 = null;
let dataSmoke;
let consumerAudit;

try {
  const stageDir = path.join(stageRoot, 'package');
  execFileSync('pnpm', ['security:audit'], { cwd: repoRoot, stdio: 'inherit' });
  const { manifest: stagedManifest } = stageBobsledPackage(stageDir);

  checkThirdPartyNotices();

  for (const lifecycle of [
    'preinstall',
    'install',
    'postinstall',
    'prepublish',
    'prepublishOnly',
    'prepack',
    'postpack',
  ]) {
    if (stagedManifest.scripts?.[lifecycle] !== undefined) {
      violations.push(`${BOBSLED_CORE_PACKAGE_NAME} declares lifecycle script ${lifecycle}`);
    }
  }

  const pack = run('npm', ['pack', '--pack-destination', tarballDir], {
    cwd: stageDir,
    timeout: 5 * 60 * 1000,
  });
  if (!recordFailure(violations, `${BOBSLED_CORE_PACKAGE_NAME} pack`, pack)) {
    const tarballName = pack.stdout.trim().split(/\r?\n/).at(-1);
    const tarball = path.join(tarballDir, tarballName);
    if (!tarballName || !existsSync(tarball)) {
      violations.push(`${BOBSLED_CORE_PACKAGE_NAME} did not produce a tarball`);
    } else {
      const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
        .split(/\r?\n/)
        .filter(Boolean);
      checkPackedThirdPartyNotices(tarball, entries);

      for (const entry of entries) {
        if (isForbiddenPackageEntry(entry)) {
          violations.push(`${BOBSLED_CORE_PACKAGE_NAME} tarball contains forbidden entry ${entry}`);
        }
      }

      for (const name of INTERNAL_PACKAGE_NAMES) {
        const manifestEntry = `package/node_modules/${name}/package.json`;
        if (!entries.includes(manifestEntry)) {
          violations.push(`tarball is missing bundled internal workspace ${name}`);
        }
      }
      for (const name of BUNDLED_EXTERNAL_PACKAGE_NAMES) {
        if (!entries.includes(`package/node_modules/${name}/package.json`)) {
          violations.push(`tarball is missing bundled external runtime ${name}`);
        }
      }
      for (const prefix of REQUIRED_ASSET_PREFIXES) {
        if (!entries.some((entry) => entry.startsWith(prefix))) {
          violations.push(`tarball is missing required asset inventory ${prefix}`);
        }
      }

      consumerAudit = await auditPackedConsumers({
        tarball,
        outputDir: path.join(outputDir, 'consumers'),
        repoRoot,
      });
      if (!consumerAudit.passed)
        violations.push('Packed consumer dependency audit has unhandled high/critical findings.');

      artifacts.push({
        package: BOBSLED_CORE_PACKAGE_NAME,
        version: stagedManifest.version,
        tarball: path.relative(outputDir, tarball),
        sha256: sha256File(tarball),
        sha512: `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`,
        entryCount: entries.length,
        bundledInternalPackages: [...INTERNAL_PACKAGE_NAMES],
        bundledExternalPackages: [...BUNDLED_EXTERNAL_PACKAGE_NAMES],
      });

      writeFileSync(
        path.join(scratch, 'package.json'),
        `${JSON.stringify({
          name: 'bobsled-security-release-smoke',
          private: true,
          type: 'module',
        })}\n`
      );
      if (violations.length === 0) {
        const install = run('npm', ['install', '--ignore-scripts', tarball], {
          cwd: scratch,
          timeout: 15 * 60 * 1000,
        });
        if (!recordFailure(violations, 'clean install', install)) {
          const installedRoot = path.join(
            scratch,
            'node_modules',
            ...BOBSLED_CORE_PACKAGE_NAME.split('/')
          );
          const installedManifest = JSON.parse(
            readFileSync(path.join(installedRoot, 'package.json'), 'utf8')
          );
          if (installedManifest.version !== stagedManifest.version) {
            violations.push(
              `installed package reports ${installedManifest.version}, expected ${stagedManifest.version}`
            );
          }
          const bundled = [...(installedManifest.bundleDependencies ?? [])].sort();
          const expectedBundled = [
            ...INTERNAL_PACKAGE_NAMES,
            ...BUNDLED_EXTERNAL_PACKAGE_NAMES,
          ].sort();
          if (
            bundled.length !== expectedBundled.length ||
            bundled.some((name, index) => name !== expectedBundled[index])
          ) {
            violations.push(
              'installed package metadata has an incomplete internal bundle inventory'
            );
          }

          for (const name of INTERNAL_PACKAGE_NAMES) {
            const topLevel = path.join(scratch, 'node_modules', ...name.split('/'));
            const nested = path.join(installedRoot, 'node_modules', ...name.split('/'));
            if (existsSync(topLevel)) {
              violations.push(`${name} resolved independently instead of from the Dogsled bundle`);
            }
            if (!existsSync(path.join(nested, 'package.json'))) {
              violations.push(`${name} is unavailable inside the installed Dogsled bundle`);
            }
          }

          const importSpecifiers = packageImportSpecifiers(stagedManifest);
          const smokeImports = run(
            process.execPath,
            [
              '--input-type=module',
              '--eval',
              `await Promise.all(${JSON.stringify(importSpecifiers)}.map((specifier) => import(specifier)))`,
            ],
            {
              cwd: scratch,
              timeout: 2 * 60 * 1000,
            }
          );
          recordFailure(violations, 'public export smoke test', smokeImports);

          const declaredBins = Object.keys(stagedManifest.bin ?? {});
          for (const binName of declaredBins) {
            const binPath = path.join(scratch, 'node_modules', '.bin', binName);
            for (const args of [
              ['--help'],
              ...DELEGATED_HELP_COMMANDS.map((command) => [command, '--help']),
            ]) {
              const smoke = run(binPath, args, {
                cwd: scratch,
                timeout: 30_000,
              });
              recordFailure(violations, `${binName} ${args.join(' ')}`, smoke);
            }
          }

          try {
            dataSmoke = smokePackedData(scratch, BOBSLED_CORE_PACKAGE_NAME);
          } catch (error) {
            violations.push(`Packed data smoke failed: ${error.message}`);
          }

          const cdxgen = executablePath('cdxgen');
          if (cdxgen) {
            const sbom = run(
              cdxgen,
              ['-t', 'npm', '-o', path.join(outputDir, 'sbom.json'), scratch],
              {
                cwd: scratch,
                timeout: 15 * 60 * 1000,
              }
            );
            sbomStatus = 'failed';
            if (!recordFailure(violations, 'SBOM generation', sbom)) {
              try {
                sbomSha256 = completeBundledSbom(path.join(outputDir, 'sbom.json'));
                sbomStatus = 'generated';
              } catch (error) {
                violations.push(`Bundled SBOM inventory failed: ${error.message}`);
              }
            }
          } else {
            violations.push(
              'cdxgen is unavailable; install the exact reviewed release-candidate version before publishing'
            );
          }
        }
      }
    }
  }
} finally {
  rmSync(stageRoot, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
}

const report = {
  schemaVersion: 4,
  commit,
  packageCount: 1,
  internalPackageCount: EXPECTED_INTERNAL_PACKAGE_COUNT,
  artifacts,
  publicImports: packageImportSpecifiers(dogsled.packageJson),
  delegatedHelpCommands: [...DELEGATED_HELP_COMMANDS],
  sbomStatus,
  sbomSha256,
  dataSmoke,
  consumerAudit,
  violations,
  passed: violations.length === 0,
};
writeJson(path.join(outputDir, 'release-report.json'), report);
writeFileSync(
  path.join(inspectionDir, 'README.txt'),
  'The release report inventories the single tarball, bundled internal packages, public imports, CLI smokes, hash, and SBOM.\n'
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (violations.length > 0) process.exitCode = 1;
