import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import semver from 'semver';
import { parse as parseYaml } from 'yaml';
import { listWorkspacePackages } from '../ci/shared.mjs';
import { INTERNAL_PACKAGE_NAMES, BOBSLED_CORE_PACKAGE_NAME } from '../release/package-set.mjs';
import {
  exemptionOverrides,
  parseReleaseAgeExemptions,
  selectDriverVersions,
  triageConsumerAudit,
  validateConsumerExceptions,
} from './consumer-policy.mjs';

const REGISTRY = 'https://registry.npmjs.org/';
function run(args, cwd, timeout = 180_000) {
  const result = spawnSync('npm', [...args, `--registry=${REGISTRY}`], {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.signal || ![0, 1].includes(result.status)) {
    throw new Error(`Consumer npm ${args[0]} did not complete successfully.`);
  }
  return result;
}

async function registryMetadata(response) {
  if (!response.body) throw new Error('Empty consumer driver metadata response.');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 64 * 1024 * 1024) throw new Error('Consumer driver metadata exceeds 64 MiB.');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export function consumerDriverRanges(packages = listWorkspacePackages()) {
  const ranges = new Map();
  for (const { name, packageJson: manifest } of packages) {
    if (!INTERNAL_PACKAGE_NAMES.includes(name)) continue;
    for (const [driver, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (!manifest.peerDependenciesMeta?.[driver]?.optional) continue;
      if (!semver.validRange(range)) {
        throw new Error(`${name} declares an unsupported ${driver} peer range ${range}.`);
      }
      ranges.set(driver, [...(ranges.get(driver) ?? []), range]);
    }
  }
  return ranges;
}

export async function auditPackedConsumers({ tarball, outputDir, repoRoot, now = Date.now() }) {
  const workspace = parseYaml(readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'));
  if (!Number.isFinite(workspace.minimumReleaseAge) || workspace.minimumReleaseAge <= 0) {
    throw new Error('Consumer audit requires the workspace release-age policy.');
  }
  const cutoff = now - workspace.minimumReleaseAge * 60_000;
  const before = new Date(cutoff).toISOString();
  const versions = { floor: {}, latest: {} };
  for (const [name, ranges] of consumerDriverRanges()) {
    const response = await fetch(`${REGISTRY}${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Cannot read consumer driver metadata for ${name}.`);
    const selected = selectDriverVersions(await registryMetadata(response), ranges, cutoff);
    for (const mode of Object.keys(versions)) versions[mode][name] = selected[mode];
  }
  const exemptions = parseReleaseAgeExemptions(workspace.minimumReleaseAgeExclude);
  const tarballs = new Map();
  const integrities = new Map();
  for (const { name, version } of exemptions) {
    const response = await fetch(`${REGISTRY}${name.replace('/', '%2F')}/${version}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Cannot read release-age exemption ${name}@${version}.`);
    const { dist } = await registryMetadata(response);
    if (!dist?.tarball?.startsWith(REGISTRY) || !dist.integrity) {
      throw new Error(`Release-age exemption ${name}@${version} has no registry tarball.`);
    }
    tarballs.set(`${name}@${version}`, dist.tarball);
    integrities.set(dist.tarball, dist.integrity);
  }
  const overrides = exemptionOverrides(exemptions, tarballs);
  const exceptions = validateConsumerExceptions(
    JSON.parse(
      readFileSync(path.join(repoRoot, 'scripts/security/consumer-exceptions.json'), 'utf8')
    )
  );
  const results = [];
  mkdirSync(outputDir, { recursive: true });
  for (const [mode, drivers] of Object.entries(versions)) {
    const scratch = mkdtempSync(path.join(os.tmpdir(), `bobsled-consumer-${mode}-`));
    const evidence = path.join(outputDir, mode);
    mkdirSync(evidence, { recursive: true });
    try {
      const manifest = {
        name: `bobsled-consumer-${mode}`,
        private: true,
        type: 'module',
        dependencies: { [BOBSLED_CORE_PACKAGE_NAME]: `file:${path.resolve(tarball)}`, ...drivers },
        ...(exemptions.length > 0 ? { overrides } : {}),
      };
      writeFileSync(path.join(scratch, 'package.json'), JSON.stringify(manifest, null, 2));
      const install = run(
        ['install', '--ignore-scripts', '--no-audit', '--no-fund', `--before=${before}`],
        scratch,
        15 * 60_000
      );
      if (install.status !== 0)
        throw new Error(`Consumer ${mode} installation failed: ${install.stderr}`);
      const lock = JSON.parse(readFileSync(path.join(scratch, 'package-lock.json'), 'utf8'));
      for (const [location, entry] of Object.entries(lock.packages ?? {})) {
        if (integrities.has(entry.resolved) && entry.integrity !== integrities.get(entry.resolved))
          throw new Error(`Consumer ${mode} installed ${location} with unexpected integrity.`);
      }
      for (const [name, version] of Object.entries(drivers)) {
        const installed = JSON.parse(
          readFileSync(path.join(scratch, 'node_modules', name, 'package.json'), 'utf8')
        );
        if (installed.version !== version)
          throw new Error(`Consumer ${mode} did not install ${name}@${version}.`);
      }
      for (const name of INTERNAL_PACKAGE_NAMES) {
        if (existsSync(path.join(scratch, 'node_modules', name)))
          throw new Error(`Consumer independently resolved ${name}.`);
      }
      const auditResult = run(['audit', '--json'], scratch);
      const audit = JSON.parse(auditResult.stdout);
      const explanations = {};
      for (const [name, item] of Object.entries(audit.vulnerabilities ?? {})) {
        if (!item.via?.some((entry) => typeof entry === 'object')) continue;
        for (const location of item.nodes ?? []) {
          const result = run(['explain', location, '--json'], scratch);
          if (result.status !== 0) throw new Error(`Consumer cannot explain installed ${name}.`);
          explanations[location] = JSON.parse(result.stdout);
        }
      }
      const triage = triageConsumerAudit(audit, explanations, exceptions, Date.now());
      for (const [filename, data] of Object.entries({
        'package.json': manifest,
        'package-lock.json': lock,
        'audit.json': audit,
        'explanations.json': explanations,
        'triage.json': triage,
      })) {
        writeFileSync(path.join(evidence, filename), `${JSON.stringify(data, null, 2)}\n`);
      }
      results.push({
        mode,
        cutoff: before,
        releaseAgeExemptions: exemptions.map(({ name, version }) => `${name}@${version}`),
        auditedAt: new Date().toISOString(),
        drivers,
        ...triage,
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  const report = { passed: results.every((result) => result.passed), results };
  writeFileSync(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
