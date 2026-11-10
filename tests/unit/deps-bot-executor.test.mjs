import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  addDocsTableRow,
  addExemptionEntry,
  addOrUpdateOverride,
  applyAction,
  branchName,
  commitMessage,
  executeActions,
  prBody,
  prLabels,
  prTitle,
  removeDocsTableRow,
  removeExemptionEntry,
  removeOverrideEntry,
} from '../../scripts/deps/executor.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_WORKSPACE = `packages:
  - packages/*

catalog:
  fast-uri: 3.1.8
  undici: 8.12.1

overrides:
  # GHSA-test: pin for security
  fast-uri: 3.1.8
  lodash: 4.18.1
  axios: 1.20.0

minimumReleaseAge: 30240

minimumReleaseAgeExclude:
  - undici@8.12.2 || 7.30.1
  - fast-uri@3.1.9
  - body-parser@2.4.0
`;

const FIXTURE_DOCS = `# Installed dependency security

Some introductory text.

## Security-fix release-age exemptions

| Package@version | Advisories | Published | Remove after | Evidence |
| --- | --- | --- | --- | --- |
| \`undici@8.12.2\` | GHSA-test | 2026-10-15 | 2026-11-05 | provenance |
| \`fast-uri@3.1.9\` | GHSA-w74x | 2026-10-19 | 2026-11-09 | provenance |
| \`body-parser@2.4.0\` | GHSA-27r3 | 2026-10-22 | 2026-11-12 | provenance |

## Driver security minimums

More content here.
`;

const FIXTURE_CONSUMER_EXCEPTIONS = [
  {
    advisory: 'GHSA-c475-qrg2-pj4r',
    package: 'basic-ftp',
    versions: ['5.3.1'],
    path: '@databricks/sql>proxy-agent>pac-proxy-agent>get-uri>basic-ftp',
    owner: 'security/release maintainers',
    status: 'not_applicable',
    expiry: '2026-11-20T00:00:00Z',
    reason: 'FTP path unreachable.',
    parentVersions: { '@databricks/sql': ['2.0.0', '2.2.0'] },
  },
];

function makeTempRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'deps-bot-test-'));
  mkdirSync(path.join(dir, 'docs'), { recursive: true });
  mkdirSync(path.join(dir, 'scripts', 'security'), { recursive: true });
  writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), FIXTURE_WORKSPACE);
  writeFileSync(path.join(dir, 'docs', 'dependency-security.md'), FIXTURE_DOCS);
  writeFileSync(
    path.join(dir, 'scripts', 'security', 'consumer-exceptions.json'),
    JSON.stringify(FIXTURE_CONSUMER_EXCEPTIONS, null, 2)
  );
  return dir;
}

// ---------------------------------------------------------------------------
// Branch naming
// ---------------------------------------------------------------------------

describe('branchName', () => {
  it('bump', () => {
    expect(branchName({ kind: 'bump', package: 'fast-uri', version: '3.1.9' })).toBe(
      'deps-bot/bump/fast-uri-3.1.9'
    );
  });

  it('bump scoped package', () => {
    expect(branchName({ kind: 'bump', package: '@azure/msal-node', version: '7.1.0' })).toBe(
      'deps-bot/bump/azure-msal-node-7.1.0'
    );
  });

  it('exempt', () => {
    expect(branchName({ kind: 'exempt', package: 'minimatch', version: '11.0.1' })).toBe(
      'deps-bot/exempt/minimatch-11.0.1'
    );
  });

  it('remove-exemption', () => {
    expect(branchName({ kind: 'remove-exemption', package: 'fast-uri', version: '3.1.9' })).toBe(
      'deps-bot/remove-exemption/fast-uri-3.1.9'
    );
  });

  it('remove-override', () => {
    expect(
      branchName({ kind: 'remove-override', package: 'lodash', pinnedVersion: '4.18.1' })
    ).toBe('deps-bot/remove-override/lodash-4.18.1');
  });

  it('returns null for unknown kinds', () => {
    expect(branchName({ kind: 'no-fix', package: 'x' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PR metadata
// ---------------------------------------------------------------------------

describe('commitMessage and prTitle', () => {
  it('bump', () => {
    const action = { kind: 'bump', package: 'x', version: '2.0.0', ghsaId: 'GHSA-test' };
    expect(commitMessage(action)).toBe('Bump x to 2.0.0 (GHSA-test)');
    expect(prTitle(action)).toBe(commitMessage(action));
  });

  it('remove-exemption', () => {
    const action = { kind: 'remove-exemption', package: 'fast-uri', version: '3.1.9' };
    expect(commitMessage(action)).toMatch(/Remove aged exemption/);
  });
});

describe('prBody', () => {
  it('bump includes Change Type dependencies', () => {
    const body = prBody({
      kind: 'bump',
      package: 'x',
      version: '2.0.0',
      ghsaId: 'GHSA-test',
      severity: 'high',
      isDirect: true,
      publishedAt: '2026-01-01',
    });
    expect(body).toContain('`dependencies`');
    expect(body).toContain('GHSA-test');
  });

  it('exempt includes evidence placeholder', () => {
    const body = prBody({
      kind: 'exempt',
      package: 'y',
      version: '1.0.0',
      ghsaId: 'GHSA-y',
      severity: 'moderate',
      publishedAt: '2026-01-01',
      removeAfter: '2026-01-22',
    });
    expect(body).toContain('Evidence');
    expect(body).toContain('Owner reviews');
  });
});

describe('prLabels', () => {
  it('exempt gets needs-owner-approval', () => {
    expect(prLabels({ kind: 'exempt' })).toEqual(['needs-owner-approval']);
  });

  it('bump gets no labels', () => {
    expect(prLabels({ kind: 'bump' })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// YAML text helpers
// ---------------------------------------------------------------------------

describe('removeExemptionEntry', () => {
  it('removes a simple entry', () => {
    const result = removeExemptionEntry(FIXTURE_WORKSPACE, 'fast-uri', '3.1.9');
    expect(result).not.toContain('fast-uri@3.1.9');
    expect(result).toContain('body-parser@2.4.0');
  });

  it('removes one version from a compound entry', () => {
    const result = removeExemptionEntry(FIXTURE_WORKSPACE, 'undici', '7.30.1');
    expect(result).toContain('undici@8.12.2');
    expect(result).not.toContain('7.30.1');
  });

  it('leaves text unchanged if entry not found', () => {
    expect(removeExemptionEntry(FIXTURE_WORKSPACE, 'missing', '1.0.0')).toBe(FIXTURE_WORKSPACE);
  });
});

describe('addExemptionEntry', () => {
  it('adds an entry after the last exemption', () => {
    const result = addExemptionEntry(FIXTURE_WORKSPACE, 'new-pkg', '1.0.0');
    expect(result).toContain('  - new-pkg@1.0.0');
    const idx = result.indexOf('new-pkg@1.0.0');
    const bodyIdx = result.indexOf('body-parser@2.4.0');
    expect(idx).toBeGreaterThan(bodyIdx);
  });

  it('quotes scoped packages', () => {
    const result = addExemptionEntry(FIXTURE_WORKSPACE, '@scope/pkg', '2.0.0');
    expect(result).toContain("  - '@scope/pkg@2.0.0'");
  });
});

describe('addOrUpdateOverride', () => {
  it('updates an existing override without touching the catalog', () => {
    const result = addOrUpdateOverride(FIXTURE_WORKSPACE, 'fast-uri', '3.1.9', 'GHSA-new');
    const overridesStart = result.indexOf('overrides:\n') + 'overrides:\n'.length;
    const nextKey = result.slice(overridesStart).search(/^\S/m);
    const overridesBlock = result.slice(overridesStart, overridesStart + nextKey);
    expect(overridesBlock).toContain('fast-uri: 3.1.9');
    expect(overridesBlock).not.toContain('fast-uri: 3.1.8');
    // Catalog still has the old version
    expect(result.slice(0, result.indexOf('overrides:'))).toContain('fast-uri: 3.1.8');
  });

  it('adds a new override', () => {
    const result = addOrUpdateOverride(FIXTURE_WORKSPACE, 'new-pkg', '1.0.0', 'GHSA-add');
    expect(result).toContain('  # GHSA-add');
    expect(result).toContain('  new-pkg: 1.0.0');
  });
});

describe('removeOverrideEntry', () => {
  it('removes an override and its comment but keeps catalog and exemption entries', () => {
    const result = removeOverrideEntry(FIXTURE_WORKSPACE, 'fast-uri');
    expect(result).not.toContain('# GHSA-test: pin for security');
    // Extract only the overrides block (up to the next top-level key)
    const overridesStart = result.indexOf('overrides:\n') + 'overrides:\n'.length;
    const nextKey = result.slice(overridesStart).search(/^\S/m);
    const overridesBlock = result.slice(overridesStart, overridesStart + nextKey);
    expect(overridesBlock).not.toContain('fast-uri');
    expect(overridesBlock).toContain('lodash: 4.18.1');
    // Catalog and exemption entries are preserved
    expect(result).toContain('fast-uri: 3.1.8'); // catalog
    expect(result).toContain('fast-uri@3.1.9'); // exemption
  });

  it('removes a plain override without preceding comment', () => {
    const result = removeOverrideEntry(FIXTURE_WORKSPACE, 'lodash');
    expect(result).not.toContain('lodash: 4.18.1');
    expect(result).toContain('axios: 1.20.0');
  });
});

describe('removeDocsTableRow', () => {
  it('removes a row matching the spec', () => {
    const result = removeDocsTableRow(FIXTURE_DOCS, 'fast-uri@3.1.9');
    expect(result).not.toContain('fast-uri@3.1.9');
    expect(result).toContain('undici@8.12.2');
    expect(result).toContain('body-parser@2.4.0');
  });
});

describe('addDocsTableRow', () => {
  it('adds a row after the last table entry', () => {
    const result = addDocsTableRow(
      FIXTURE_DOCS,
      'new-pkg@1.0.0',
      'GHSA-new',
      '2026-11-01',
      '2026-11-22'
    );
    expect(result).toContain('| `new-pkg@1.0.0`');
    const newIdx = result.indexOf('new-pkg@1.0.0');
    const bodyIdx = result.indexOf('body-parser@2.4.0');
    expect(newIdx).toBeGreaterThan(bodyIdx);
  });
});

// ---------------------------------------------------------------------------
// applyAction (integration with temp directory)
// ---------------------------------------------------------------------------

describe('applyAction', () => {
  it('bump: updates override and removes exemption and docs row', () => {
    const dir = makeTempRepo();
    try {
      applyAction(
        {
          kind: 'bump',
          package: 'fast-uri',
          version: '3.1.9',
          ghsaId: 'GHSA-w74x',
          severity: 'moderate',
          isDirect: false,
          publishedAt: '2026-10-19',
        },
        dir
      );

      const ws = readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8');
      expect(ws).toContain('fast-uri: 3.1.9');
      expect(ws).not.toContain('fast-uri@3.1.9');

      const docs = readFileSync(path.join(dir, 'docs', 'dependency-security.md'), 'utf8');
      expect(docs).not.toContain('`fast-uri@3.1.9`');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bump direct: updates catalog entry', () => {
    const dir = makeTempRepo();
    try {
      applyAction(
        {
          kind: 'bump',
          package: 'fast-uri',
          version: '3.1.9',
          ghsaId: 'GHSA-w74x',
          severity: 'moderate',
          isDirect: true,
          publishedAt: '2026-10-19',
        },
        dir
      );

      const ws = readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8');
      expect(ws).toMatch(/^\s+fast-uri:\s+3\.1\.9$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exempt: adds exemption entry, override, and docs row', () => {
    const dir = makeTempRepo();
    try {
      applyAction(
        {
          kind: 'exempt',
          package: 'minimatch',
          version: '11.0.1',
          ghsaId: 'GHSA-min',
          severity: 'moderate',
          isDirect: false,
          publishedAt: '2026-10-27',
          removeAfter: '2026-11-17',
        },
        dir
      );

      const ws = readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8');
      expect(ws).toContain('minimatch@11.0.1');
      expect(ws).toContain('minimatch: 11.0.1');

      const docs = readFileSync(path.join(dir, 'docs', 'dependency-security.md'), 'utf8');
      expect(docs).toContain('`minimatch@11.0.1`');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('remove-exemption: removes exemption entry and docs row', () => {
    const dir = makeTempRepo();
    try {
      applyAction(
        {
          kind: 'remove-exemption',
          package: 'fast-uri',
          version: '3.1.9',
          publishedAt: '2026-10-19',
          agedOutAt: '2026-11-09',
        },
        dir
      );

      const ws = readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8');
      expect(ws).not.toContain('fast-uri@3.1.9');
      expect(ws).toContain('body-parser@2.4.0');

      const docs = readFileSync(path.join(dir, 'docs', 'dependency-security.md'), 'utf8');
      expect(docs).not.toContain('`fast-uri@3.1.9`');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('remove-override: removes the override entry', () => {
    const dir = makeTempRepo();
    try {
      applyAction(
        {
          kind: 'remove-override',
          package: 'lodash',
          pinnedVersion: '4.18.1',
          resolvedWithout: '4.18.2',
        },
        dir
      );

      const ws = readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8');
      expect(ws).not.toContain('lodash: 4.18.1');
      expect(ws).toContain('axios: 1.20.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// executeActions with fake ops
// ---------------------------------------------------------------------------

function makeFakeOps(existingBranches = new Set()) {
  const gitLog = [];
  const githubLog = [];
  let prCounter = 0;

  const gitOps = {
    createBranch(branch) {
      gitLog.push({ op: 'createBranch', branch });
    },
    applyPatch(patchPath) {
      gitLog.push({ op: 'applyPatch', patchPath });
    },
    commit(message) {
      gitLog.push({ op: 'commit', message });
    },
    push(branch) {
      gitLog.push({ op: 'push', branch });
    },
    checkoutMain() {
      gitLog.push({ op: 'checkoutMain' });
    },
  };

  const githubOps = {
    async hasOpenPR(branch) {
      githubLog.push({ op: 'hasOpenPR', branch });
      return existingBranches.has(branch);
    },
    async createPR({ branch, title, body, labels }) {
      prCounter++;
      githubLog.push({ op: 'createPR', branch, title, labels });
      return `https://github.com/test/repo/pull/${prCounter}`;
    },
    async sendSlack(message) {
      githubLog.push({ op: 'sendSlack', message });
    },
  };

  return { gitOps, githubOps, gitLog, githubLog };
}

function makePlanDir(actions, patches) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'deps-exec-test-'));
  writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ actions }, null, 2));

  if (patches && patches.length > 0) {
    mkdirSync(path.join(dir, 'patches'));
    for (const p of patches) {
      writeFileSync(path.join(dir, 'patches', `${p.id}.patch`), p.patch ?? 'fake patch content');
      writeFileSync(
        path.join(dir, 'patches', `${p.id}.meta.json`),
        JSON.stringify({
          branch: p.branch,
          title: p.title ?? `PR for ${p.id}`,
          body: p.body ?? 'test body',
          commitMessage: p.commitMessage ?? `commit for ${p.id}`,
          labels: p.labels ?? [],
          action: p.action ?? {},
        })
      );
    }
  }

  return dir;
}

describe('executeActions', () => {
  it('creates a PR for a bump patch', async () => {
    const dir = makePlanDir(
      [{ kind: 'bump', package: 'fast-uri', version: '3.1.9' }],
      [
        {
          id: '000-bump-fast-uri',
          branch: 'deps-bot/bump/fast-uri-3.1.9',
          title: 'Bump fast-uri to 3.1.9',
          commitMessage: 'Bump fast-uri to 3.1.9 (GHSA-test)',
          labels: [],
        },
      ]
    );
    try {
      const { gitOps, githubOps, gitLog, githubLog } = makeFakeOps();
      const results = await executeActions(dir, gitOps, githubOps);

      expect(results).toHaveLength(1);
      expect(results[0].skipped).toBe(false);
      expect(results[0].url).toContain('pull/1');

      expect(gitLog.map((e) => e.op)).toEqual([
        'createBranch',
        'applyPatch',
        'commit',
        'push',
        'checkoutMain',
      ]);
      expect(githubLog.find((e) => e.op === 'createPR').branch).toBe(
        'deps-bot/bump/fast-uri-3.1.9'
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates a PR for an exempt patch with labels', async () => {
    const dir = makePlanDir(
      [{ kind: 'exempt', package: 'minimatch', version: '11.0.1' }],
      [
        {
          id: '000-exempt-minimatch',
          branch: 'deps-bot/exempt/minimatch-11.0.1',
          labels: ['needs-owner-approval'],
        },
      ]
    );
    try {
      const { gitOps, githubOps, githubLog } = makeFakeOps();
      const results = await executeActions(dir, gitOps, githubOps);

      expect(results).toHaveLength(1);
      expect(results[0].skipped).toBe(false);
      expect(githubLog.find((e) => e.op === 'createPR').labels).toEqual(['needs-owner-approval']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates a PR for a remove-exemption patch', async () => {
    const dir = makePlanDir(
      [{ kind: 'remove-exemption', package: 'fast-uri', version: '3.1.9' }],
      [
        {
          id: '000-remove-exemption-fast-uri',
          branch: 'deps-bot/remove-exemption/fast-uri-3.1.9',
        },
      ]
    );
    try {
      const { gitOps, githubOps } = makeFakeOps();
      const results = await executeActions(dir, gitOps, githubOps);
      expect(results).toHaveLength(1);
      expect(results[0].skipped).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates a PR for a remove-override patch', async () => {
    const dir = makePlanDir(
      [{ kind: 'remove-override', package: 'lodash', pinnedVersion: '4.18.1' }],
      [
        {
          id: '000-remove-override-lodash',
          branch: 'deps-bot/remove-override/lodash-4.18.1',
        },
      ]
    );
    try {
      const { gitOps, githubOps } = makeFakeOps();
      const results = await executeActions(dir, gitOps, githubOps);
      expect(results).toHaveLength(1);
      expect(results[0].skipped).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips when a PR already exists for the branch', async () => {
    const dir = makePlanDir(
      [{ kind: 'bump', package: 'fast-uri', version: '3.1.9' }],
      [
        {
          id: '000-bump-fast-uri',
          branch: 'deps-bot/bump/fast-uri-3.1.9',
        },
      ]
    );
    try {
      const existing = new Set(['deps-bot/bump/fast-uri-3.1.9']);
      const { gitOps, githubOps, gitLog, githubLog } = makeFakeOps(existing);
      const results = await executeActions(dir, gitOps, githubOps);

      expect(results).toHaveLength(1);
      expect(results[0].skipped).toBe(true);
      expect(gitLog).toHaveLength(0);
      expect(githubLog.filter((e) => e.op === 'createPR')).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends Slack for no-fix actions', async () => {
    const dir = makePlanDir(
      [
        {
          kind: 'no-fix',
          package: 'vuln-pkg',
          ghsaId: 'GHSA-nofix',
          severity: 'critical',
          reason: 'No fixed version.',
        },
      ],
      []
    );
    try {
      const { gitOps, githubOps, githubLog } = makeFakeOps();
      await executeActions(dir, gitOps, githubOps);

      const slack = githubLog.find((e) => e.op === 'sendSlack');
      expect(slack).toBeTruthy();
      expect(slack.message).toContain('vuln-pkg');
      expect(slack.message).toContain('GHSA-nofix');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends Slack for deadline-warning actions', async () => {
    const dir = makePlanDir(
      [
        {
          kind: 'deadline-warning',
          source: 'audit-ci',
          key: 'GHSA-test|path',
          expiry: '2026-11-12',
          daysLeft: 3,
        },
      ],
      []
    );
    try {
      const { gitOps, githubOps, githubLog } = makeFakeOps();
      await executeActions(dir, gitOps, githubOps);

      const slack = githubLog.find((e) => e.op === 'sendSlack');
      expect(slack).toBeTruthy();
      expect(slack.message).toContain('Deadline');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles empty plan with no patches', async () => {
    const dir = makePlanDir([], []);
    try {
      const { gitOps, githubOps, gitLog } = makeFakeOps();
      const results = await executeActions(dir, gitOps, githubOps);
      expect(results).toHaveLength(0);
      expect(gitLog).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates a PR for an update-exception patch', async () => {
    const dir = makePlanDir(
      [
        {
          kind: 'update-exception',
          advisory: 'GHSA-c475-qrg2-pj4r',
          package: 'basic-ftp',
          version: '5.3.1',
          path: '@databricks/sql>proxy-agent>pac-proxy-agent>get-uri>basic-ftp',
        },
      ],
      [
        {
          id: '000-update-exception-basic-ftp',
          branch: 'deps-bot/update-exception/basic-ftp-GHSA-c475-qrg2-pj4r',
          labels: ['needs-owner-approval'],
        },
      ]
    );
    try {
      const { gitOps, githubOps, githubLog } = makeFakeOps();
      const results = await executeActions(dir, gitOps, githubOps);
      expect(results).toHaveLength(1);
      expect(results[0].skipped).toBe(false);
      expect(githubLog.find((e) => e.op === 'createPR').labels).toEqual(['needs-owner-approval']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// applyAction: update-exception
// ---------------------------------------------------------------------------

describe('applyAction update-exception', () => {
  it('adds the new parent version to consumer-exceptions.json', () => {
    const dir = makeTempRepo();
    try {
      applyAction(
        {
          kind: 'update-exception',
          advisory: 'GHSA-c475-qrg2-pj4r',
          package: 'basic-ftp',
          version: '5.3.1',
          path: '@databricks/sql>proxy-agent>pac-proxy-agent>get-uri>basic-ftp',
          newParentVersions: {
            '@databricks/sql': { reviewed: ['2.0.0', '2.2.0'], actual: '2.3.0' },
          },
        },
        dir
      );

      const exceptions = JSON.parse(
        readFileSync(path.join(dir, 'scripts', 'security', 'consumer-exceptions.json'), 'utf8')
      );
      const entry = exceptions.find((e) => e.advisory === 'GHSA-c475-qrg2-pj4r');
      expect(entry.parentVersions['@databricks/sql']).toContain('2.3.0');
      expect(entry.parentVersions['@databricks/sql']).toContain('2.0.0');
      expect(entry.parentVersions['@databricks/sql']).toContain('2.2.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not duplicate an already-listed parent version', () => {
    const dir = makeTempRepo();
    try {
      applyAction(
        {
          kind: 'update-exception',
          advisory: 'GHSA-c475-qrg2-pj4r',
          package: 'basic-ftp',
          version: '5.3.1',
          path: '@databricks/sql>proxy-agent>pac-proxy-agent>get-uri>basic-ftp',
          newParentVersions: {
            '@databricks/sql': { reviewed: ['2.0.0', '2.2.0'], actual: '2.2.0' },
          },
        },
        dir
      );

      const exceptions = JSON.parse(
        readFileSync(path.join(dir, 'scripts', 'security', 'consumer-exceptions.json'), 'utf8')
      );
      const entry = exceptions.find((e) => e.advisory === 'GHSA-c475-qrg2-pj4r');
      const databricksVersions = entry.parentVersions['@databricks/sql'];
      expect(databricksVersions.filter((v) => v === '2.2.0')).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Branch naming and PR metadata for new action kinds
// ---------------------------------------------------------------------------

describe('update-exception metadata', () => {
  it('branchName', () => {
    expect(
      branchName({
        kind: 'update-exception',
        package: 'basic-ftp',
        advisory: 'GHSA-c475-qrg2-pj4r',
      })
    ).toBe('deps-bot/update-exception/basic-ftp-GHSA-c475-qrg2-pj4r');
  });

  it('commitMessage', () => {
    expect(
      commitMessage({
        kind: 'update-exception',
        package: 'basic-ftp',
        advisory: 'GHSA-c475-qrg2-pj4r',
      })
    ).toMatch(/Update consumer exception.*basic-ftp/);
  });

  it('prLabels includes needs-owner-approval', () => {
    expect(prLabels({ kind: 'update-exception' })).toEqual(['needs-owner-approval']);
  });

  it('prBody includes owner checklist', () => {
    const body = prBody({
      kind: 'update-exception',
      package: 'basic-ftp',
      advisory: 'GHSA-c475-qrg2-pj4r',
      path: '@databricks/sql>proxy-agent>pac-proxy-agent>get-uri>basic-ftp',
      newParentVersions: {
        '@databricks/sql': { reviewed: ['2.0.0', '2.2.0'], actual: '2.3.0' },
      },
      isLookahead: false,
    });
    expect(body).toContain('Owner checklist');
    expect(body).toContain('reachability reasoning');
    expect(body).toContain('2.3.0');
    expect(body).toContain('`dependencies`');
  });
});
