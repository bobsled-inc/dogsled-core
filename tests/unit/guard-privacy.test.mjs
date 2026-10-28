import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  PRIVACY_RULES,
  parsePrivacyExceptions,
  scanPrivacyFile,
  validatePrivacyExceptions,
} from '../../scripts/guards/privacy.mjs';
import { scanFileLines } from '../../scripts/guards/lib.mjs';

/**
 * Helper: scan a single line against all privacy rules and return a map
 * of rule-id to match count.
 */
function countMatches(line, relativePath = 'test.txt') {
  const results = scanFileLines(relativePath, [line], PRIVACY_RULES);
  return Object.fromEntries([...results].map(([id, findings]) => [id, findings.length]));
}

// ---------------------------------------------------------------------------
// Email addresses
// ---------------------------------------------------------------------------

describe('email-address', () => {
  it('catches a real email address', () => {
    expect(countMatches('contact person@company.io')['email-address']).toBe(1);
  });

  it('catches gmail addresses', () => {
    expect(countMatches('user: john.doe@gmail.com')['email-address']).toBe(1);
  });

  it('allows example.com', () => {
    expect(countMatches('test@example.com')['email-address']).toBe(0);
  });

  it('allows example.org', () => {
    expect(countMatches('test@example.org')['email-address']).toBe(0);
  });

  it('allows example.net', () => {
    expect(countMatches('test@example.net')['email-address']).toBe(0);
  });

  it('rejects unreserved demo domains', () => {
    expect(countMatches('demo.person@examplemail.com')['email-address']).toBe(1);
  });

  it('allows .test TLD', () => {
    expect(countMatches('user@mail.test')['email-address']).toBe(0);
  });

  it('allows .invalid TLD', () => {
    expect(countMatches('user@host.invalid')['email-address']).toBe(0);
  });

  it('rejects noreply@ addresses on unreserved domains', () => {
    expect(countMatches('noreply@anthropic.com')['email-address']).toBe(1);
  });

  it('rejects no-reply@ addresses on unreserved domains', () => {
    expect(countMatches('no-reply@company.com')['email-address']).toBe(1);
  });

  it('allows GitHub noreply', () => {
    expect(countMatches('user@users.noreply.github.com')['email-address']).toBe(0);
  });

  it('rejects fake local parts like test@ on unreserved domains', () => {
    expect(countMatches('test@anydomain.com')['email-address']).toBe(1);
  });

  it('allows fixture@example.com', () => {
    expect(countMatches('fixture@example.com')['email-address']).toBe(0);
  });

  it('rejects fake local part alice@ on unreserved domains', () => {
    expect(countMatches('alice@company.org')['email-address']).toBe(1);
  });

  it('allows each public project contact only in the files that state its purpose', () => {
    const exceptions = parsePrivacyExceptions(
      readFileSync(new URL('../../scripts/guards/privacy-exceptions.json', import.meta.url), 'utf8')
    );
    const findings = (file, address) =>
      scanPrivacyFile(file, [address], exceptions).get('email-address');
    const security = 'security@dogsledai.com';
    const maintainers = 'maintainers@dogsledai.com';
    expect(findings('SECURITY.md', security)).toEqual([]);
    expect(findings('CODE_OF_CONDUCT.md', maintainers)).toEqual([]);
    expect(findings('SUPPORT.md', maintainers)).toEqual([]);
    expect(findings('CODE_OF_CONDUCT.md', security)).toHaveLength(1);
    expect(findings('SECURITY.md', maintainers)).toHaveLength(1);
    expect(findings('README.md', maintainers)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Personal machine paths
// ---------------------------------------------------------------------------

describe('personal-machine-path', () => {
  it('catches /Users/<name>/ paths', () => {
    expect(countMatches('/Users/developer/projects')['personal-machine-path']).toBe(1);
  });

  it('catches /home/<name>/ paths', () => {
    expect(countMatches('/home/deploy/app')['personal-machine-path']).toBe(1);
  });

  it('catches Windows C:\\Users\\<name> paths', () => {
    expect(countMatches('C:\\Users\\JohnDoe\\Desktop')['personal-machine-path']).toBe(1);
  });

  it('allows /Users/me placeholder', () => {
    expect(countMatches('/Users/me/projects')['personal-machine-path']).toBe(0);
  });

  it('allows /home/user placeholder', () => {
    expect(countMatches('/home/user/app')['personal-machine-path']).toBe(0);
  });

  it('allows /Users/<you> template', () => {
    expect(countMatches('/Users/<you>/work')['personal-machine-path']).toBe(0);
  });

  it('allows variable syntax', () => {
    expect(countMatches('/Users/$USER/work')['personal-machine-path']).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Private infrastructure
// ---------------------------------------------------------------------------

describe('artifact-registry', () => {
  it('catches pkg.dev paths', () => {
    expect(countMatches('us-docker.pkg.dev/my-project')['artifact-registry']).toBe(1);
  });
});

describe('vercel-preview-host', () => {
  it('catches *.vercel.app hosts', () => {
    expect(countMatches('app-git-branch-team.vercel.app')['vercel-preview-host']).toBe(1);
  });
});

describe('neon-host', () => {
  it('catches *.neon.tech hosts', () => {
    expect(countMatches('ep-cool-rain-123456.neon.tech')['neon-host']).toBe(1);
  });
});

describe('dogsled-subdomain', () => {
  it('catches *.dogsled.it subdomains', () => {
    expect(countMatches('customer.dogsled.it')['dogsled-subdomain']).toBe(1);
  });
});

describe('gcloud-project-url', () => {
  it('catches Google Cloud console project URLs', () => {
    expect(
      countMatches('console.cloud.google.com/storage/projects/my-gcp-project')['gcloud-project-url']
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Private tool links
// ---------------------------------------------------------------------------

describe('linear-link', () => {
  it('catches linear.app/ links', () => {
    expect(countMatches('https://linear.app/team/issue')['linear-link']).toBe(1);
  });
});

describe('notion-link', () => {
  it('catches notion.so links', () => {
    expect(countMatches('https://notion.so/page')['notion-link']).toBe(1);
  });

  it('catches notion.site links', () => {
    expect(countMatches('https://notion.site/page')['notion-link']).toBe(1);
  });

  it('catches app.notion.com links', () => {
    expect(countMatches('https://app.notion.com/page')['notion-link']).toBe(1);
  });
});

describe('slack-archive-link', () => {
  it('catches slack.com/archives/ links', () => {
    expect(countMatches('https://slack.com/archives/C123')['slack-archive-link']).toBe(1);
  });
});

describe('private-github-repo', () => {
  it('catches links to private bobsled-inc repos', () => {
    expect(
      countMatches('https://github.com/bobsled-inc/private-example')['private-github-repo']
    ).toBe(1);
  });

  it('catches links to other private repos', () => {
    expect(
      countMatches('https://github.com/bobsled-inc/private-other')['private-github-repo']
    ).toBe(1);
  });

  it('allows links to the future public repo dogsled-core', () => {
    expect(countMatches('https://github.com/bobsled-inc/dogsled-core')['private-github-repo']).toBe(
      0
    );
  });

  it('allows dogsled-core.git', () => {
    expect(countMatches('git@github.com/bobsled-inc/dogsled-core.git')['private-github-repo']).toBe(
      0
    );
  });
});

describe('privacy guard trust boundaries', () => {
  it('allows reserved subdomains and rejects similar registrable domains', () => {
    expect(countMatches('sample@tenant.example.com')['email-address']).toBe(0);
    expect(countMatches('sample@example.com.attacker.io')['email-address']).toBe(1);
  });

  it('keeps exact exceptions scoped to their files and match positions', () => {
    const exceptions = validatePrivacyExceptions({
      version: 1,
      exceptions: [
        {
          rule: 'email-address',
          files: ['public.md'],
          values: ['contact@provider.io'],
          reason: 'Reviewed public contact for a fixture test.',
        },
      ],
    });
    expect(
      scanPrivacyFile('public.md', ['contact@provider.io private@company.io'], exceptions).get(
        'email-address'
      )
    ).toHaveLength(1);
    expect(
      scanPrivacyFile('other.md', ['contact@provider.io'], exceptions).get('email-address')
    ).toHaveLength(1);
    expect(
      scanPrivacyFile('public.md', ['contact@provider.io.attacker.net'], exceptions).get(
        'email-address'
      )
    ).toHaveLength(1);
  });

  it('requires exact exception paths and a reason', () => {
    expect(() =>
      validatePrivacyExceptions({
        version: 1,
        exceptions: [
          {
            rule: 'email-address',
            files: ['**/*.md'],
            values: ['contact@provider.io'],
            reason: 'Reviewed contact.',
          },
        ],
      })
    ).toThrow(/exact file/);
    expect(() =>
      validatePrivacyExceptions({
        version: 1,
        exceptions: [
          {
            rule: 'email-address',
            files: ['public.md'],
            values: ['contact@provider.io'],
            reason: '',
          },
        ],
      })
    ).toThrow(/review reason/);
  });

  it('recognizes quoted generic home paths without exempting other users', () => {
    expect(countMatches("HOME: '/home/user',")['personal-machine-path']).toBe(0);
    expect(countMatches("HOME: '/home/account',")['personal-machine-path']).toBe(0);
    expect(countMatches("HOME: '/home/developer',")['personal-machine-path']).toBe(1);
  });

  it('allows public provider docs and endpoints while rejecting workspace links', () => {
    expect(countMatches('https://mcp.linear.app/mcp')['linear-link']).toBe(0);
    expect(countMatches('https://developers.linear.app/docs/graphql')['linear-link']).toBe(0);
    expect(countMatches('https://linear.app/team/issue/ENG-123')['linear-link']).toBe(1);
    expect(countMatches('https://mcp.linear.app/mcp?workspace=private')['linear-link']).toBe(1);
    expect(countMatches('https://www.notion.so/images/favicon.ico')['notion-link']).toBe(0);
    expect(countMatches('https://www.notion.so/private-page')['notion-link']).toBe(1);
  });

  it('flags ticket identifiers in source while preserving standards and fixture samples', () => {
    expect(
      countMatches('Related to ENG-123', 'packages/demo/src/read.ts')['ticket-id-in-source']
    ).toBe(1);
    expect(
      countMatches('Related to ENG-123', 'packages/demo/tests/read.test.ts')['ticket-id-in-source']
    ).toBe(0);
    expect(
      countMatches('SHA-256, UTF-8, IEEE-754 and SCD-2', 'packages/demo/src/read.ts')[
        'ticket-id-in-source'
      ]
    ).toBe(0);
  });
});

describe('serialized source fixtures', () => {
  it('distinguishes escaped newlines before decorators from email addresses', () => {
    expect(countMatches(String.raw`\n@mcp.tool()`)['email-address']).toBe(0);
    expect(countMatches(String.raw`\nprivate@company.io`)['email-address']).toBe(1);
    expect(countMatches(String.raw`\nn@company.io`)['email-address']).toBe(1);
  });
});

it('does not echo invalid exception content in diagnostics', () => {
  expect(() => parsePrivacyExceptions('{"values":["private@company.io"')).toThrow(
    'Invalid privacy exceptions; use exact files and emails with review reasons.'
  );
});

it('rejects operator application endpoints while allowing the public provider', () => {
  const hostname = ['app', 'bobsled', 'cloud'].join('.');
  expect(countMatches(`https://${hostname}/api`)['operator-host']).toBe(1);
  expect(countMatches('https://api.bobsled.com')['operator-host']).toBe(0);
});

describe('clickhouse-cloud-host', () => {
  it.each([
    'abc123xyz0.us-central1.gcp.clickhouse.cloud',
    'https://abc123xyz0.us-east-1.aws.clickhouse.cloud:8443',
    'ABC123XYZ0.WESTUS3.AZURE.CLICKHOUSE.CLOUD',
    'abc123xyz0.clickhouse.cloud',
  ])('rejects a service hostname in %s', (host) => {
    expect(countMatches(host)['clickhouse-cloud-host']).toBe(1);
  });

  it.each([
    'example.us-central1.gcp.clickhouse.cloud',
    'https://example.us-central1.gcp.clickhouse.cloud:8443',
    'ch.example.com',
    'https://clickhouse.com/docs',
  ])('allows the example or public documentation %s', (host) => {
    expect(countMatches(host)['clickhouse-cloud-host']).toBe(0);
  });

  it('reports each service host even beside an allowed example', () => {
    const line =
      'example.us-central1.gcp.clickhouse.cloud abc123xyz0.us-east-1.aws.clickhouse.cloud';
    const findings = scanPrivacyFile('fixture.txt', [line]).get('clickhouse-cloud-host');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: 'fixture.txt',
      line: 1,
      column: line.indexOf('abc123xyz0') + 1,
    });
  });
});

describe('managed-service-host', () => {
  const hosts = [
    'xy12345.snowflakecomputing.com',
    'org-account.us-east-1.privatelink.snowflakecomputing.com',
    'dbc-a1b2c3.cloud.databricks.com',
    'adb-123456789.7.azuredatabricks.net',
    'abcdefghijklmnopqrst.supabase.co',
    'cluster0.a1b2c.mongodb.net',
    'database.abc123.us-east-1.rds.amazonaws.com',
    'warehouse.abc123.us-east-1.redshift.amazonaws.com',
    'database.abc123.cn-north-1.rds.amazonaws.com.cn',
    'server123.database.windows.net',
  ];

  it.each(hosts)('rejects the managed service %s', (host) => {
    expect(countMatches(host)['managed-service-host']).toBe(1);
    expect(countMatches(`https://${host.toUpperCase()}:443/path`)['managed-service-host']).toBe(1);
  });

  it.each(hosts)('allows an explicit example placeholder for %s', (host) => {
    const example = host.replace(/^[^.]+/, 'example');
    expect(countMatches(example)['managed-service-host']).toBe(0);
  });

  it.each([
    'dbc-example.cloud.databricks.com',
    'adb-example.7.azuredatabricks.net',
    'db.example.com',
    'https://docs.snowflake.com',
    'https://docs.databricks.com',
    'https://api.supabase.com',
    'https://www.mongodb.com/docs',
    'https://learn.microsoft.com',
  ])('allows the placeholder or vendor endpoint %s', (host) => {
    expect(countMatches(host)['managed-service-host']).toBe(0);
  });

  it.each(['my-example', 'example-project', 'sub.example', 'dbc-example', 'adb-example'])(
    'does not exempt %s',
    (prefix) => {
      expect(countMatches(`${prefix}.supabase.co`)['managed-service-host']).toBe(1);
    }
  );

  it('reports an unreserved host beside a placeholder without returning matched text', () => {
    const line = 'example.supabase.co tenant123.supabase.co';
    expect(scanPrivacyFile('fixture.yml', [line]).get('managed-service-host')).toEqual([
      { file: 'fixture.yml', line: 1, column: 21 },
    ]);
  });
});

describe('hosted-consumer-wording', () => {
  it.each([
    'Lakehouse agent',
    'Lakehouse-agent',
    'LAKEHOUSE AGENTS',
    'Lakehouse\nagent',
    'Lakehouse\r\n * agent',
    'Lakehouse\n// agent',
    String.raw`Lakehouse\nagent`,
    'closed-source app',
    'proprietary Dogsled app',
    String.raw`closed\nsource\napplication`,
  ])('detects consumer wording in %s', (text) => {
    expect(countMatches(text)['hosted-consumer-wording']).toBe(1);
    expect(scanPrivacyFile('doc.md', text.split('\n')).get('hosted-consumer-wording')).toHaveLength(
      1
    );
  });

  it('keeps source locations when wording spans lines', () => {
    expect(
      scanPrivacyFile('doc.md', [
        'Heading',
        'The Lakehouse',
        ' * agent consumes metadata.',
        'Another proprietary',
        'Dogsled app.',
      ]).get('hosted-consumer-wording')
    ).toEqual([
      { file: 'doc.md', line: 2, column: 5 },
      { file: 'doc.md', line: 4, column: 9 },
    ]);
  });

  it.each([
    'host application',
    'agent host',
    'Lakehouse storage formats',
    'Dogsled Cloud',
    'dogsled_managed',
  ])('allows neutral wording and documented hooks: %s', (text) =>
    expect(countMatches(text)['hosted-consumer-wording']).toBe(0)
  );
});

it('allows exact public ClickHouse hosts without exempting service subdomains', () => {
  expect(countMatches('https://api.clickhouse.cloud/v1')['clickhouse-cloud-host']).toBe(0);
  expect(countMatches('https://console.clickhouse.cloud')['clickhouse-cloud-host']).toBe(0);
  expect(countMatches('tenant.api.clickhouse.cloud')['clickhouse-cloud-host']).toBe(1);
});
