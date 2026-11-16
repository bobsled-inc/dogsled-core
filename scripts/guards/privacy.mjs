import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  classifyArea,
  GUARD_SELF_REFERENCE_PATHS,
  compareSection,
  guardsDir,
  listScanFiles,
  parseArgs,
  readBaseline,
  repoRoot,
  scanFileLines,
  writeBaseline,
} from './lib.mjs';

const WORD_SEPARATOR = String.raw`(?:[\s-]|\\[nr]|\/\/|\*)+`;
const HOSTED_CONSUMER_PATTERN = new RegExp(
  String.raw`\blakehouse${WORD_SEPARATOR}agents?\b|\b(?:closed${WORD_SEPARATOR}source|proprietary)${WORD_SEPARATOR}(?:dogsled${WORD_SEPARATOR})?app(?:lication)?\b`,
  'gi'
);

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const RESERVED_DOMAIN = /(?:^|\.)example\.(?:com|org|net)$|\.(?:example|test|invalid)$/i;
const GENERIC_HOME_NAMES = new Set([
  'me',
  'user',
  'you',
  'account',
  'runner',
  'node',
  '<you>',
  '<user>',
  '<name>',
]);

function isAllowedEmail(email) {
  const domain = email.toLowerCase().split('@')[1];
  return !domain || RESERVED_DOMAIN.test(domain) || domain === 'users.noreply.github.com';
}

function isPublicToolUrl(candidate, tool) {
  try {
    const url = new URL(`https://${candidate.replace(/[),.;]+$/, '')}`);
    if (url.search || url.hash) return false;
    if (tool === 'notion') {
      return url.hostname === 'www.notion.so' && url.pathname === '/images/favicon.ico';
    }
    if (url.hostname === 'api.linear.app') return ['/', '/graphql'].includes(url.pathname);
    if (url.hostname === 'mcp.linear.app') return ['/mcp', '/sse'].includes(url.pathname);
    if (url.hostname === 'developers.linear.app') return /^\/docs(?:\/|$)/.test(url.pathname);
    return (
      url.hostname === 'linear.app' &&
      (/^\/docs(?:\/|$)/.test(url.pathname) ||
        ['/', '/favicon.ico', '/settings/api'].includes(url.pathname))
    );
  } catch {
    return false;
  }
}

function scanToolLinks(line, tool) {
  const regex =
    tool === 'linear'
      ? /\b(?:[a-z0-9-]+\.)?linear\.app\/[^\s"'`<>\\]*/gi
      : /\b(?:(?:[a-z0-9-]+\.)?notion\.(?:so|site)|app\.notion\.com)\/[^\s"'`<>\\]*/gi;
  return [...line.matchAll(regex)]
    .filter((match) => !isPublicToolUrl(match[0], tool))
    .map((match) => ({ column: match.index + 1 }));
}

export const PRIVACY_RULES = [
  {
    id: 'email-address',
    description: 'Emails outside reserved domains and reviewed exact exceptions',
    scan(line) {
      return [...line.matchAll(EMAIL_PATTERN)]
        .filter(
          (match) =>
            !isAllowedEmail(match[0]) &&
            !(line[match.index - 1] === '\\' && /^[nrt]@/.test(match[0]))
        )
        .map((match) => ({ column: match.index + 1 }));
    },
  },
  {
    id: 'personal-machine-path',
    description: 'Personal home directories outside generic placeholders',
    scan(line) {
      const matches = [];
      const patterns = [
        /(?:\/Users\/|\/home\/)([^/\s\\'"`)\]},;]+)/g,
        /\b[A-Z]:\\Users\\([^\\\s'"`)\]},;]+)/gi,
      ];
      for (const regex of patterns) {
        for (const match of line.matchAll(regex)) {
          const name = match[1];
          if (GENERIC_HOME_NAMES.has(name) || /^[${<]/.test(name)) continue;
          matches.push({ column: match.index + 1 });
        }
      }
      return matches;
    },
  },
  {
    id: 'artifact-registry',
    description: 'Private Artifact Registry hosts',
    regex: /[a-z0-9-]+-(?:docker|npm|python|apt|yum|maven)\.pkg\.dev\b/g,
  },
  {
    id: 'vercel-preview-host',
    description: 'Preview deployment hosts',
    regex: /[a-z0-9][-a-z0-9]*\.vercel\.app\b/g,
  },
  {
    id: 'clickhouse-cloud-host',
    description: 'Managed ClickHouse service hosts outside the example placeholder',
    scan(line) {
      return [...line.matchAll(/\b([a-z0-9][a-z0-9-]*)\.(?:[a-z0-9-]+\.)*clickhouse\.cloud\b/gi)]
        .filter(
          (match) =>
            match[1].toLowerCase() !== 'example' &&
            !['api.clickhouse.cloud', 'console.clickhouse.cloud'].includes(match[0].toLowerCase())
        )
        .map((match) => ({ column: match.index + 1 }));
    },
  },
  {
    id: 'managed-service-host',
    description: 'Managed database and warehouse hosts outside example placeholders',
    scan(line) {
      const pattern =
        /\b(?:[a-z0-9][a-z0-9-]*\.)+(?:snowflakecomputing\.com|supabase\.co|mongodb\.net|(?:rds|redshift)\.amazonaws\.com(?:\.cn)?|database\.windows\.net)\b|\b(?:dbc|adb)-[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:databricks\.com|azuredatabricks\.net)\b/gi;
      return [...line.matchAll(pattern)]
        .filter((match) => {
          const host = match[0].toLowerCase();
          const label = host.split('.')[0];
          return (
            label !== 'example' &&
            !(
              ['dbc-example', 'adb-example'].includes(label) &&
              /\.(?:databricks\.com|azuredatabricks\.net)$/.test(host)
            )
          );
        })
        .map((match) => ({ column: match.index + 1 }));
    },
  },
  {
    id: 'hosted-consumer-wording',
    description: 'Hosted-product consumer wording, including wrapped and serialized text',
    regex: HOSTED_CONSUMER_PATTERN,
  },
  {
    id: 'neon-host',
    description: 'Database service hosts',
    regex: /[a-z0-9][-a-z0-9]*\.neon\.tech\b/g,
  },
  {
    id: 'bobsled-subdomain',
    description: 'Private application subdomains',
    regex: /[a-z0-9][-a-z0-9]*\.dogsled\.it\b/g,
  },
  {
    id: 'gcloud-project-url',
    description: 'Project IDs in Cloud URLs',
    regex: /(?:console\.cloud\.google\.com|googleapis\.com)\/[^\s]*projects\/[a-z][a-z0-9-]*/g,
  },
  {
    id: 'linear-link',
    description: 'Private workspace links; public provider endpoints remain allowed',
    scan(line) {
      return scanToolLinks(line, 'linear');
    },
  },
  {
    id: 'notion-link',
    description: 'Workspace and page links; public provider favicon remains allowed',
    scan(line) {
      return scanToolLinks(line, 'notion');
    },
  },
  {
    id: 'slack-archive-link',
    description: 'Workspace archive links',
    regex: /\bslack\.com\/archives\//g,
  },
  {
    id: 'private-github-repo',
    description: 'Company repositories other than the public release repository',
    scan(line) {
      return [...line.matchAll(/github\.com\/bobsled-inc\/([a-z0-9._-]+)/gi)]
        .filter((match) => match[1].toLowerCase().replace(/\.git$/, '') !== 'bobsled-core')
        .map((match) => ({ column: match.index + 1 }));
    },
  },
  {
    id: 'ticket-id-in-source',
    description: 'Ticket-shaped identifiers in runtime source',
    scan(line, relativePath = '') {
      if (!relativePath.includes('/src/')) return [];
      const standards = new Set([
        'SHA',
        'UTF',
        'ISO',
        'RFC',
        'CVE',
        'ANSI',
        'ECMA',
        'CRC',
        'AES',
        'FIPS',
        'TLS',
        'SSL',
        'HTTP',
        'IEEE',
        'SCD',
      ]);
      return [...line.matchAll(/(?<![A-Z0-9])[A-Z]{2,8}-\d{1,6}(?![A-Z0-9])/g)]
        .filter((match) => !standards.has(match[0].split('-')[0]))
        .map((match) => ({ column: match.index + 1 }));
    },
  },
  {
    id: 'operator-host',
    description: 'Operator application or telemetry endpoints',
    regex: /https?:\/\/(?:app|api|telemetry|events)\.bobsled\.(?:co|ai|cloud)\b/gi,
  },
];

export function validatePrivacyExceptions(data) {
  if (data?.version !== 1 || !Array.isArray(data.exceptions))
    throw new Error('Invalid privacy exceptions document');
  for (const entry of data.exceptions) {
    if (
      entry.rule !== 'email-address' ||
      typeof entry.reason !== 'string' ||
      entry.reason.trim().length < 12 ||
      !Array.isArray(entry.files) ||
      !entry.files.length ||
      !Array.isArray(entry.values) ||
      !entry.values.length ||
      entry.files.some(
        (file) =>
          typeof file !== 'string' ||
          !file ||
          path.posix.normalize(file) !== file ||
          file.startsWith('/') ||
          file.split('/').includes('..') ||
          /[*?\[\]{}\\]/.test(file)
      ) ||
      entry.values.some(
        (value) =>
          typeof value !== 'string' ||
          !/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(value)
      )
    ) {
      throw new Error('Privacy exceptions require an exact file, exact email, and review reason');
    }
  }
  return data.exceptions;
}

export function parsePrivacyExceptions(content) {
  try {
    return validatePrivacyExceptions(JSON.parse(content));
  } catch {
    throw new Error('Invalid privacy exceptions; use exact files and emails with review reasons.');
  }
}

const PRIVACY_EXCEPTIONS = parsePrivacyExceptions(
  readFileSync(path.join(guardsDir, 'privacy-exceptions.json'), 'utf8')
);

export function scanPrivacyFile(relativePath, lines, exceptions = PRIVACY_EXCEPTIONS) {
  const results = scanFileLines(
    relativePath,
    lines,
    PRIVACY_RULES.filter((rule) => rule.id !== 'hosted-consumer-wording')
  );
  const wordingFindings = [];
  let lineIndex = 0;
  let lineStart = 0;
  for (const match of lines.join('\n').matchAll(HOSTED_CONSUMER_PATTERN)) {
    while (lineIndex + 1 < lines.length && lineStart + lines[lineIndex].length < match.index) {
      lineStart += lines[lineIndex].length + 1;
      lineIndex++;
    }
    wordingFindings.push({
      file: relativePath,
      line: lineIndex + 1,
      column: match.index - lineStart + 1,
    });
  }
  results.set('hosted-consumer-wording', wordingFindings);
  for (const [rule, findings] of results) {
    results.set(
      rule,
      findings.filter((finding) => {
        const value = lines[finding.line - 1]
          .slice(finding.column - 1)
          .match(/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)?.[0];
        return !exceptions.some(
          (entry) =>
            entry.rule === rule &&
            entry.files.includes(relativePath) &&
            entry.values.includes(value)
        );
      })
    );
  }
  return results;
}

const BASELINE_PATH = path.join(guardsDir, 'privacy-baseline.json');

export function runScan() {
  const files = listScanFiles({ includeLockfile: true, includeSvg: true });
  const ruleCounts = Object.fromEntries(PRIVACY_RULES.map((rule) => [rule.id, 0]));
  const areaCounts = {};
  const ruleFindings = Object.fromEntries(PRIVACY_RULES.map((rule) => [rule.id, []]));
  for (const relativePath of files) {
    if (GUARD_SELF_REFERENCE_PATHS.has(relativePath)) continue;
    let content;
    try {
      content = readFileSync(path.join(repoRoot, relativePath), 'utf8');
    } catch {
      continue;
    }
    const findings = scanPrivacyFile(relativePath, content.split('\n'));
    let total = 0;
    for (const [id, values] of findings) {
      ruleCounts[id] += values.length;
      ruleFindings[id].push(...values);
      total += values.length;
    }
    if (total) {
      const area = classifyArea(relativePath);
      areaCounts[area] = (areaCounts[area] ?? 0) + total;
    }
  }
  return { ruleCounts, areaCounts, ruleFindings };
}

function main() {
  const args = parseArgs();
  const isUpdate = args.update === true;
  const { ruleCounts, areaCounts, ruleFindings } = runScan();

  if (isUpdate) {
    const baseline = readBaseline(BASELINE_PATH);
    if (baseline) {
      const ruleCheck = compareSection(baseline.rules, ruleCounts, 'rule');
      const areaCheck = compareSection(baseline.areas, areaCounts, 'area');
      if (ruleCheck.increases.length > 0 || areaCheck.increases.length > 0) {
        process.stderr.write(
          'Refusing to update: some counts increased. Fix the regressions first.\n'
        );
        for (const inc of [...ruleCheck.increases, ...areaCheck.increases]) {
          process.stderr.write(
            `  ${inc.label} ${inc.key}: ${inc.baseline} -> ${inc.current} (+${inc.current - inc.baseline})\n`
          );
        }
        process.exitCode = 1;
        return;
      }
    }

    writeBaseline(BASELINE_PATH, {
      version: 1,
      generatedAt: new Date().toISOString(),
      rules: ruleCounts,
      areas: areaCounts,
    });
    const total = Object.values(ruleCounts).reduce((sum, n) => sum + n, 0);
    process.stdout.write(
      `Privacy baseline updated (${total} total findings across ${Object.keys(areaCounts).length} areas).\n`
    );
    return;
  }

  // Check mode: compare against baseline
  const baseline = readBaseline(BASELINE_PATH);
  if (!baseline) {
    process.stderr.write(
      'No baseline found. Run with --update to create one: pnpm guard:privacy --update\n'
    );
    process.exitCode = 1;
    return;
  }

  const ruleCheck = compareSection(baseline.rules, ruleCounts, 'rule');
  const areaCheck = compareSection(baseline.areas, areaCounts, 'area');
  const total = Object.values(ruleCounts).reduce((sum, n) => sum + n, 0);

  if (ruleCheck.ok && areaCheck.ok) {
    const decreased =
      ruleCheck.decreases.length + areaCheck.decreases.length > 0 ? ' (some decreased)' : '';
    process.stdout.write(`Privacy guard passed (${total} total findings)${decreased}.\n`);
    if (ruleCheck.decreases.length > 0 || areaCheck.decreases.length > 0) {
      process.stdout.write('Run `pnpm guard:privacy --update` to ratchet the baseline down.\n');
    }
    return;
  }

  // Report findings without matched text — only rule-id and file:line
  process.stderr.write('Privacy guard FAILED: counts increased over baseline.\n\n');
  for (const inc of ruleCheck.increases) {
    process.stderr.write(
      `Rule "${inc.key}": ${inc.baseline} -> ${inc.current} (+${inc.current - inc.baseline})\n`
    );
    const findings = ruleFindings[inc.key] ?? [];
    const examples = findings.slice(0, 10);
    for (const finding of examples) {
      process.stderr.write(`  ${inc.key} ${finding.file}:${finding.line}\n`);
    }
    if (findings.length > 10) {
      process.stderr.write(`  ... and ${findings.length - 10} more\n`);
    }
    process.stderr.write('\n');
  }
  for (const inc of areaCheck.increases) {
    process.stderr.write(
      `Area "${inc.key}": ${inc.baseline} -> ${inc.current} (+${inc.current - inc.baseline})\n`
    );
  }

  process.exitCode = 1;
}

// Only run when executed directly, not when imported by tests.
import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
