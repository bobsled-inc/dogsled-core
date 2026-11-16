import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  exemptionOverrides,
  parseReleaseAgeExemptions,
  selectDriverVersions,
  triageConsumerAudit,
  validateConsumerExceptions,
} from '../../scripts/security/consumer-policy.mjs';

const now = Date.parse('2026-10-21T12:00:00Z');
function explanation(parent = 'snowflake-sdk', version = '3.0.0') {
  return [
    {
      name: 'toml',
      version,
      location: 'node_modules/toml',
      dependents: [
        {
          from: {
            name: parent,
            version: '3.3.0',
            location: `node_modules/${parent}`,
            dependents: [{ from: { name: 'consumer' } }],
          },
        },
      ],
    },
  ];
}
const audit = {
  auditReportVersion: 2,
  vulnerabilities: {
    toml: {
      severity: 'high',
      nodes: ['node_modules/toml'],
      via: [
        {
          severity: 'high',
          url: 'https://github.com/advisories/GHSA-82x6-q7mm-w9cf',
          range: '<4.2.0',
        },
      ],
    },
  },
};
const exception = {
  advisory: 'GHSA-82x6-q7mm-w9cf',
  package: 'toml',
  versions: ['3.0.0'],
  path: 'snowflake-sdk>toml',
  parentVersions: { 'snowflake-sdk': ['3.3.0'] },
  owner: 'security/release maintainers',
  status: 'not_applicable',
  reason: 'Explicit connection options avoid TOML parsing.',
  expiry: '2026-11-20T00:00:00Z',
};
function triage(exceptions = [exception], nodes = explanation(), report = audit, at = now) {
  return triageConsumerAudit(report, { 'node_modules/toml': nodes }, exceptions, at);
}
describe('consumer release-age driver selection', () => {
  const metadata = {
    name: 'driver',
    versions: { '1.0.0': {}, '1.2.0': {}, '2.0.0': {}, '2.1.0-beta.1': {} },
    time: {
      '1.0.0': '2020-01-01',
      '1.2.0': '2026-09-01',
      '2.0.0': '2026-10-20',
      '2.1.0-beta.1': '2026-01-01',
    },
  };
  it('selects the actual published floor and latest version satisfying every peer', () => {
    expect(selectDriverVersions(metadata, ['>=1.0.0', '^1.1.0'], Date.parse('2026-09-30'))).toEqual(
      { floor: '1.2.0', latest: '1.2.0' }
    );
  });
  it('rejects a floor that has not met the release-age policy', () => {
    expect(() => selectDriverVersions(metadata, ['>=2.0.0'], Date.parse('2026-09-30'))).toThrow(
      'No age-eligible version'
    );
  });
  it('supports explicitly permitted DuckDB prerelease version ranges', () => {
    expect(
      selectDriverVersions(
        {
          name: 'duckdb',
          versions: { '1.4.4-r.3': {}, '1.4.4-r.4': {} },
          time: { '1.4.4-r.3': '2026-01-01', '1.4.4-r.4': '2026-02-01' },
        },
        ['^1.4.4-r.3'],
        now
      )
    ).toEqual({ floor: '1.4.4-r.3', latest: '1.4.4-r.4' });
  });
});
describe('actual consumer dependency advisory gate', () => {
  it('allows only the reviewed advisory, installed version and exact dependency path', () => {
    expect(triage().passed).toBe(true);
    expect(triage().findings[0]).toMatchObject({
      advisory: 'GHSA-82x6-q7mm-w9cf',
      disposition: 'not_applicable',
      path: 'consumer>snowflake-sdk>toml',
      version: '3.0.0',
      owner: exception.owner,
      expiry: exception.expiry,
    });
  });
  it('reports a reachable, deliberately accepted exception as accepted_risk', () => {
    const result = triage([{ ...exception, status: 'accepted_risk' }]);
    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([
      expect.objectContaining({
        advisory: 'GHSA-82x6-q7mm-w9cf',
        path: 'consumer>snowflake-sdk>toml',
        disposition: 'accepted_risk',
        owner: 'security/release maintainers',
        expiry: '2026-11-20T00:00:00Z',
      }),
    ]);
  });
  it.each(['accepted_risk', 'not_applicable'])(
    'reports an expired %s exception as unhandled without its owner',
    (status) => {
      const result = triage(
        [{ ...exception, status }],
        explanation(),
        audit,
        Date.parse(exception.expiry) + 1
      );
      expect(result.passed).toBe(false);
      expect(result.findings[0].disposition).toBe('unhandled');
      expect(result.findings[0]).not.toHaveProperty('owner');
    }
  );
  it.each([undefined, '', 'accepted', 'NOT_APPLICABLE'])(
    'fails validation for an exception with status %j',
    (status) => {
      const entry = { ...exception, status };
      if (status === undefined) delete entry.status;
      expect(() => validateConsumerExceptions([entry])).toThrow('requires status');
      expect(() => triage([entry])).toThrow('requires status');
    }
  );
  it('fails validation for a malformed exception list', () => {
    expect(() => validateConsumerExceptions({})).toThrow('must be a list');
    expect(() => validateConsumerExceptions([null])).toThrow('must be an object');
  });
  it('fails on unhandled high/critical instead of relying on wrapper package findings', () => {
    expect(triage([]).passed).toBe(false);
    const critical = structuredClone(audit);
    critical.vulnerabilities.toml.via[0].severity = 'critical';
    expect(triage([], explanation(), critical).passed).toBe(false);
  });
  it('does not extend an exception to other parents, versions or advisories', () => {
    expect(triage([exception], explanation('other-sdk')).passed).toBe(false);
    expect(triage([exception], explanation('snowflake-sdk', '3.0.1')).passed).toBe(false);
    expect(triage([{ ...exception, advisory: 'GHSA-other' }]).passed).toBe(false);
  });
  it('requires re-review when a driver version changes before an exception expires', () => {
    const nodes = explanation();
    nodes[0].dependents[0].from.version = '3.4.0';
    expect(triage([exception], nodes).passed).toBe(false);
  });

  it('does not replace the nearest SDK version with an older ancestor of the same name', () => {
    const nodes = explanation();
    const nearest = nodes[0].dependents[0].from;
    nearest.version = '3.4.0';
    nearest.location = 'node_modules/snowflake-sdk/node_modules/helper/node_modules/snowflake-sdk';
    nearest.dependents = [
      {
        from: {
          name: 'helper',
          location: 'node_modules/snowflake-sdk/node_modules/helper',
          dependents: [
            {
              from: {
                name: 'snowflake-sdk',
                version: '3.3.0',
                location: 'node_modules/snowflake-sdk',
                dependents: [{ from: { name: 'consumer' } }],
              },
            },
          ],
        },
      },
    ];
    expect(triage([exception], nodes).passed).toBe(false);
  });

  it.each([undefined, 'not-a-range', {}])(
    'fails closed for malformed advisory range %s',
    (range) => {
      const invalid = structuredClone(audit);
      invalid.vulnerabilities.toml.via[0].range = range;
      expect(() => triage([], explanation(), invalid)).toThrow('Malformed npm audit semver');
    }
  );

  it('fails closed for an unverifiable installed version', () => {
    expect(() => triage([], explanation('snowflake-sdk', 'unknown'))).toThrow(
      'Malformed npm audit semver'
    );
  });

  it('does not hide another incoming path for a shared vulnerable dependency', () => {
    const nodes = explanation();
    nodes[0].dependents.push(...explanation('other-sdk')[0].dependents);
    expect(triage([exception], nodes).passed).toBe(false);
  });
  it('retains lower-severity paths for phase-6 review without allowlisting them', () => {
    const lower = structuredClone(audit);
    lower.vulnerabilities.toml.via[0].severity = 'moderate';
    const result = triage([exception], explanation(), lower);
    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.followups).toEqual([
      expect.objectContaining({
        severity: 'moderate',
        path: 'consumer>snowflake-sdk>toml',
        disposition: 'review_before_phase_6',
      }),
    ]);
  });

  it('fails at the review deadline and requires an owner and rationale', () => {
    expect(triage([exception], explanation(), audit, Date.parse(exception.expiry)).passed).toBe(
      false
    );
    expect(triage([{ ...exception, owner: '' }]).passed).toBe(false);
    expect(triage([{ ...exception, reason: '' }]).passed).toBe(false);
  });
  it('fails closed on failed audits or missing installed-tree evidence', () => {
    expect(() => triage([], [], { error: { code: 'network' } })).toThrow('malformed');
    expect(() => triage([], [])).toThrow('Missing installed');
    expect(() => triage([], [], { auditReportVersion: 2, vulnerabilities: [] })).toThrow(
      'malformed'
    );
    expect(() =>
      triage([], [], {
        auditReportVersion: 2,
        vulnerabilities: { wrapper: { via: ['missing'], nodes: [] } },
      })
    ).toThrow('Missing npm audit dependency');

    const invalid = structuredClone(audit);
    invalid.vulnerabilities.toml.via[0].url = 'unknown';
    expect(() => triage([], explanation(), invalid)).toThrow('Missing advisory identity');
  });
});

describe('consumer driver ranges', () => {
  it('reads optional driver peers from the internal workspace manifests', async () => {
    const { consumerDriverRanges } = await import('../../scripts/security/consumer-audit.mjs');
    const ranges = consumerDriverRanges([
      {
        name: '@bobsled-inc/loader',
        packageJson: {
          peerDependencies: { pg: '>=8.4.0', mysql2: '>=3.22.0', required: '1.0.0' },
          peerDependenciesMeta: { pg: { optional: true }, mysql2: { optional: true } },
        },
      },
      {
        name: '@bobsled-inc/connections',
        packageJson: {
          peerDependencies: { pg: '>=8.4.0' },
          peerDependenciesMeta: { pg: { optional: true } },
        },
      },
      {
        name: 'outside',
        packageJson: {
          peerDependencies: { other: '1.0.0' },
          peerDependenciesMeta: { other: { optional: true } },
        },
      },
    ]);
    expect(Object.fromEntries(ranges)).toEqual({
      pg: ['>=8.4.0', '>=8.4.0'],
      mysql2: ['>=3.22.0'],
    });
  });

  it('keeps the reviewed driver inventory after staging strips bundled peers', async () => {
    const { consumerDriverRanges } = await import('../../scripts/security/consumer-audit.mjs');
    const ranges = consumerDriverRanges();
    expect(ranges.get('pg')).toEqual(['^8.4.0', '^8.4.0']);
    expect(ranges.get('snowflake-sdk')).toContain('>=3.4.0');
  });
});

describe('reviewed consumer exception statuses', () => {
  const entries = JSON.parse(
    readFileSync(
      new URL('../../scripts/security/consumer-exceptions.json', import.meta.url),
      'utf8'
    )
  );
  it('gives every reviewed exception an explicit status', () => {
    expect(validateConsumerExceptions(entries)).toBe(entries);
  });
  it('keeps no accepted-risk exception after the undici fetch client fix', () => {
    expect(entries.filter((entry) => entry.status === 'accepted_risk')).toEqual([]);
    expect(entries.some((entry) => entry.package === 'undici')).toBe(false);
  });
});

describe('removed TOML consumer exceptions', () => {
  const entries = JSON.parse(
    readFileSync(
      new URL('../../scripts/security/consumer-exceptions.json', import.meta.url),
      'utf8'
    )
  );
  it.each(['GHSA-4qx8-w7c3-pj3p', 'GHSA-9j65-hcg3-gc64', 'GHSA-9qmh-m7c6-f92p'])(
    'no longer allows %s for the Snowflake tree',
    (id) => {
      const report = structuredClone(audit);
      report.vulnerabilities.toml.via[0] = {
        severity: 'high',
        url: `https://github.com/advisories/${id}`,
        range: '<=5.0.0',
      };
      const nodes = explanation('snowflake-sdk', '5.0.0');
      nodes[0].dependents[0].from.version = '3.4.0';
      expect(triage(entries, nodes, report).passed).toBe(false);
    }
  );
});

describe('reviewed transitive advisory consumer exceptions', () => {
  const entries = JSON.parse(
    readFileSync(
      new URL('../../scripts/security/consumer-exceptions.json', import.meta.url),
      'utf8'
    )
  );
  function chainExplanation(name, version, chain) {
    let from = { name: 'consumer' };
    for (const [parent, parentVersion] of chain) {
      from = {
        name: parent,
        version: parentVersion,
        location: `node_modules/${parent}`,
        dependents: [{ from }],
      };
    }
    return [{ name, version, location: `node_modules/${name}`, dependents: [{ from }] }];
  }
  function chainTriage({ id, name, version, range, chain }, at = now) {
    const report = {
      auditReportVersion: 2,
      vulnerabilities: {
        [name]: {
          severity: 'high',
          nodes: [`node_modules/${name}`],
          via: [{ severity: 'high', url: `https://github.com/advisories/${id}`, range }],
        },
      },
    };
    return triageConsumerAudit(
      report,
      { [`node_modules/${name}`]: chainExplanation(name, version, chain) },
      entries,
      at
    ).passed;
  }
  const dogsled = ['@bobsled-inc/bobsled-core', '0.62.0'];
  const sdk = ['@modelcontextprotocol/sdk', '1.32.0'];
  it.each([
    ['GHSA-xjj6-f33q-929c', 'undici', '8.11.2', [dogsled]],
    ['GHSA-xjj6-f33q-929c', 'undici', '7.30.0', [['@turbopuffer/turbopuffer', '2.0.0']]],
    ['GHSA-mrhx-c7xc-m3w5', 'zod', '4.3.6', [dogsled]],
    ['GHSA-mrhx-c7xc-m3w5', 'zod', '4.6.5', [dogsled, sdk]],
    ['GHSA-27r3-jxmh-p828', 'body-parser', '2.3.0', [dogsled, sdk, ['express', '5.2.1']]],
    [
      'GHSA-xcx6-jx8p-x3h5',
      '@azure/msal-node',
      '6.0.1',
      [
        ['snowflake-sdk', '3.4.0'],
        ['@azure/identity', '4.13.3'],
      ],
    ],
    [
      'GHSA-xcx6-jx8p-x3h5',
      '@azure/msal-node',
      '6.0.1',
      [
        ['tedious', '20.3.4'],
        ['@azure/identity', '4.13.3'],
      ],
    ],
  ])('no longer allows %s for %s %s after the fixed release', (id, name, version, chain) => {
    expect(chainTriage({ id, name, version, range: '<9999.0.0', chain })).toBe(false);
  });
});

describe('release-age exemptions', () => {
  it('accepts only exact versions, alone or joined with ||', () => {
    expect(parseReleaseAgeExemptions(['undici@8.12.2 || 7.30.1', '@next/env@15.5.28'])).toEqual([
      { name: 'undici', version: '8.12.2' },
      { name: 'undici', version: '7.30.1' },
      { name: '@next/env', version: '15.5.28' },
    ]);
    expect(parseReleaseAgeExemptions(undefined)).toEqual([]);
    for (const entry of [
      'undici',
      '@myorg/*',
      'undici@^8.12.2',
      'undici@8.12.2 || 7.x',
      'undici@',
    ]) {
      expect(() => parseReleaseAgeExemptions([entry])).toThrow('must name exact versions');
    }
    expect(() => parseReleaseAgeExemptions('undici@8.12.2')).toThrow('must be a list');
  });

  it('pins each exempted version to its registry tarball within its own major line', () => {
    const exemptions = parseReleaseAgeExemptions(['undici@8.12.2 || 7.30.1', 'tiny@0.3.1']);
    const tarballs = new Map(
      ['undici@8.12.2', 'undici@7.30.1', 'tiny@0.3.1'].map((spec) => [spec, `tarball ${spec}`])
    );
    expect(exemptionOverrides(exemptions, tarballs)).toEqual({
      'undici@8.x': 'tarball undici@8.12.2',
      'undici@7.x': 'tarball undici@7.30.1',
      'tiny@0.3.x': 'tarball tiny@0.3.1',
    });
    expect(() =>
      exemptionOverrides(parseReleaseAgeExemptions(['undici@8.12.2 || 8.12.3']), tarballs)
    ).toThrow('overlap');
    expect(() => exemptionOverrides(parseReleaseAgeExemptions(['other@1.0.0']), tarballs)).toThrow(
      'Missing registry tarball'
    );
  });
});
