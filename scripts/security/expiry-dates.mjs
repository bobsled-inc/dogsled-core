/**
 * Collect all dependency-related expiry dates from the repository:
 * release-age exemption removal dates, audit-ci allowlist expiries,
 * and consumer-exception review deadlines.
 *
 * Used by the structural test (grace-period logic) and the deps:expiries CLI.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const MS_PER_DAY = 86_400_000;

/** Default grace period (days) before a release-age exemption removal fails the test. */
export const EXEMPTION_GRACE_DAYS = 3;

/**
 * Determine the status of an expiry date relative to now.
 * @param {string} dateStr  ISO date string
 * @param {number} graceDays  Days after the date before it becomes 'expired'
 * @param {number} now  Current timestamp (ms)
 * @returns {'ok' | 'warning' | 'expired'}
 */
export function expiryStatus(dateStr, graceDays, now = Date.now()) {
  const date = Date.parse(dateStr);
  if (Number.isNaN(date)) return 'expired';
  if (now < date) return 'ok';
  if (graceDays > 0 && now < date + graceDays * MS_PER_DAY) return 'warning';
  return 'expired';
}

/**
 * Compute the number of whole days remaining until a date.
 * Negative means the date has passed.
 */
export function daysUntil(dateStr, now = Date.now()) {
  const date = Date.parse(dateStr);
  if (Number.isNaN(date)) return -Infinity;
  return Math.ceil((date - now) / MS_PER_DAY);
}

/**
 * Collect every expiry date from the three repository sources.
 * Each entry: { source, label, date, graceDays, daysLeft, status }.
 */
export function collectExpiryDates(repoRoot, now = Date.now()) {
  const entries = [];

  // 1. Release-age exemption removal dates from docs/dependency-security.md.
  const guidePath = path.join(repoRoot, 'docs', 'dependency-security.md');
  const guide = readFileSync(guidePath, 'utf8');
  const section = guide.split('## Security-fix release-age exemptions\n')[1]?.split('\n## ')[0];
  if (section) {
    for (const row of section.split('\n').filter((line) => /^\| `/.test(line))) {
      const cells = row
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim());
      const [packages, , , removal] = cells;
      if (removal && !Number.isNaN(Date.parse(removal))) {
        for (const [, spec] of packages.matchAll(/`([^`]+)`/g)) {
          entries.push({
            source: 'release-age exemption',
            label: spec,
            date: removal,
            graceDays: EXEMPTION_GRACE_DAYS,
          });
        }
      }
    }
  }

  // 2. audit-ci.json allowlist expiry dates.
  const auditCiPath = path.join(repoRoot, 'audit-ci.json');
  const auditCi = JSON.parse(readFileSync(auditCiPath, 'utf8'));
  for (const entry of auditCi.allowlist ?? []) {
    for (const [key, config] of Object.entries(entry)) {
      if (config && typeof config === 'object' && config.expiry) {
        entries.push({
          source: 'audit-ci allowlist',
          label: key.split('|')[0],
          date: config.expiry,
          graceDays: 0,
        });
      }
    }
  }

  // 3. consumer-exceptions.json review deadlines.
  const exceptionsPath = path.join(repoRoot, 'scripts', 'security', 'consumer-exceptions.json');
  const exceptions = JSON.parse(readFileSync(exceptionsPath, 'utf8'));
  for (const entry of exceptions) {
    if (entry.expiry) {
      entries.push({
        source: 'consumer exception',
        label: `${entry.advisory} ${entry.package}`,
        date: entry.expiry,
        graceDays: 0,
      });
    }
  }

  return entries.map((entry) => ({
    ...entry,
    daysLeft: daysUntil(entry.date, now),
    status: expiryStatus(entry.date, entry.graceDays, now),
  }));
}
