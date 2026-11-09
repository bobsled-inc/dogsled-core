#!/usr/bin/env node

/**
 * List every upcoming dependency-related expiry date: release-age exemption
 * removal dates, audit-ci allowlist expiries, and consumer-exception review
 * deadlines. Shows days left and exits non-zero when anything is past its
 * grace period or due within a configurable window.
 *
 * Usage:
 *   node scripts/deps-expiries.mjs                # list only
 *   node scripts/deps-expiries.mjs --fail-within 3  # fail if anything due within 3 days
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectExpiryDates } from './security/expiry-dates.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

let failWithin = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--fail-within' && i + 1 < args.length) {
    failWithin = Number(args[i + 1]);
    if (!Number.isFinite(failWithin) || failWithin < 0) {
      console.error('--fail-within requires a non-negative number of days.');
      process.exitCode = 2;
      throw new Error('Invalid --fail-within value.');
    }
    i++;
  }
}

const entries = collectExpiryDates(repoRoot);

if (entries.length === 0) {
  console.log('No dependency expiry dates found.');
} else {
  const sorted = [...entries].sort((a, b) => a.daysLeft - b.daysLeft);
  console.log('');
  console.log('Dependency expiry dates');
  console.log('─'.repeat(80));
  for (const entry of sorted) {
    const icon =
      entry.status === 'expired' ? 'EXPIRED' : entry.status === 'warning' ? 'WARNING' : '     ok';
    const days =
      entry.daysLeft <= 0 ? `${Math.abs(entry.daysLeft)}d overdue` : `${entry.daysLeft}d left`;
    console.log(`  [${icon}]  ${days.padEnd(14)} ${entry.source.padEnd(24)} ${entry.label}`);
    console.log(
      `           date: ${entry.date}${entry.graceDays ? `  (${entry.graceDays}d grace)` : ''}`
    );
  }
  console.log('─'.repeat(80));
  console.log('');
}

const expired = entries.filter((e) => e.status === 'expired');
const dueSoon =
  failWithin !== null
    ? entries.filter((e) => e.status !== 'expired' && e.daysLeft <= failWithin)
    : [];

if (expired.length > 0) {
  console.error(`${expired.length} expiry date(s) past their grace period.`);
  process.exitCode = 1;
}
if (dueSoon.length > 0) {
  console.error(`${dueSoon.length} expiry date(s) due within ${failWithin} days.`);
  process.exitCode = 1;
}
