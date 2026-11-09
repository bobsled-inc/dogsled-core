import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';

import { parseReleaseAgeExemptions } from '../security/consumer-policy.mjs';

/**
 * I/O layer for the dependency maintenance bot.
 * Reads local config files, calls APIs, runs subprocesses.
 */

export function readWorkspaceConfig(root) {
  const workspace = parseYaml(readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8'));
  return {
    releaseAgeMinutes: workspace.minimumReleaseAge,
    exemptions: parseReleaseAgeExemptions(workspace.minimumReleaseAgeExclude),
    overrides: workspace.overrides ?? {},
  };
}

export function readAuditCiConfig(root) {
  const config = JSON.parse(readFileSync(path.join(root, 'audit-ci.json'), 'utf8'));
  return config.allowlist ?? [];
}

export function readConsumerExceptions(root) {
  return JSON.parse(
    readFileSync(path.join(root, 'scripts', 'security', 'consumer-exceptions.json'), 'utf8')
  );
}

export function readDocsTable(root) {
  const guide = readFileSync(path.join(root, 'docs', 'dependency-security.md'), 'utf8');
  const section = guide.split('## Security-fix release-age exemptions\n')[1]?.split('\n## ')[0];
  if (!section) return new Map();
  const removeAfter = new Map();
  for (const row of section.split('\n').filter((line) => /^\| `/.test(line))) {
    const cells = row
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    const packages = cells[0];
    const removal = cells[3];
    if (!packages || !removal) continue;
    for (const [, spec] of packages.matchAll(/`([^`]+)`/g)) {
      removeAfter.set(spec, removal);
    }
  }
  return removeAfter;
}

export async function fetchDependabotAlerts(owner, repo, token) {
  const url = `https://api.github.com/repos/${owner}/${repo}/dependabot/alerts?state=open&ecosystem=npm&per_page=100`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error(`Dependabot alerts API returned ${response.status} ${response.statusText}`);
  }
  return response.json();
}

export async function fetchPackument(name) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name).replace('%40', '@')}`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`npm registry returned ${response.status} for ${name}`);
  }
  return response.json();
}

export function runPnpmAudit(root) {
  try {
    const output = execFileSync('pnpm', ['audit', '--json'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
    });
    return JSON.parse(output);
  } catch (error) {
    if (error.stdout) {
      try {
        return JSON.parse(error.stdout);
      } catch {
        throw new Error(`pnpm audit produced unparseable output: ${error.message}`);
      }
    }
    throw error;
  }
}

/**
 * Check whether a single override can be safely removed. Creates a scratch
 * workspace file without the override and runs `pnpm install --lockfile-only`.
 * Returns the version pnpm resolves without the override, or null on error.
 */
export async function checkOverrideRemovable(root, overrideName, pinnedVersion) {
  const workspacePath = path.join(root, 'pnpm-workspace.yaml');
  const workspace = parseYaml(readFileSync(workspacePath, 'utf8'));

  const overrides = { ...workspace.overrides };
  delete overrides[overrideName];

  const modified = { ...workspace, overrides };
  const modifiedYaml = JSON.stringify(modified);

  const { mkdtempSync, writeFileSync, cpSync, rmSync } = await import('node:fs');
  const os = await import('node:os');

  const scratch = mkdtempSync(path.join(os.tmpdir(), 'deps-bot-override-'));
  try {
    cpSync(root, scratch, {
      recursive: true,
      filter: (src) => !src.includes('node_modules') && !src.includes('.git'),
    });
    writeFileSync(path.join(scratch, 'pnpm-workspace.yaml'), modifiedYaml);

    execFileSync('pnpm', ['install', '--lockfile-only'], {
      cwd: scratch,
      encoding: 'utf8',
      timeout: 120_000,
      stdio: 'pipe',
    });

    const lockfile = readFileSync(path.join(scratch, 'pnpm-lock.yaml'), 'utf8');
    const lock = parseYaml(lockfile);
    const packageKey = Object.keys(lock.packages ?? {}).find((key) =>
      key.startsWith(`${overrideName}@`)
    );
    const resolved = packageKey?.split('@').pop() ?? null;

    return { name: overrideName, pinnedVersion, resolvedWithout: resolved, error: null };
  } catch (error) {
    return { name: overrideName, pinnedVersion, resolvedWithout: null, error: error.message };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
