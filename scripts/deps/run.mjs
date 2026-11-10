#!/usr/bin/env node

/**
 * CLI entry point for the dependency maintenance bot.
 *
 * Modes (--mode or DEPS_BOT env):
 *   off       Exit immediately.
 *   dry-run   Plan only, write JSON to --output (default /tmp/deps-plan).
 *   prepare   Plan + create patches for each action (plan job, no write token).
 *   execute   Apply patches, push branches, open PRs (act job, write token).
 *
 * Environment:
 *   DEPS_BOT              off | dry-run | prepare | execute
 *   GITHUB_TOKEN          For Dependabot alerts and PR creation
 *   GITHUB_REPOSITORY     owner/repo
 *   GITHUB_STEP_SUMMARY   Path to write the step summary
 *   SLACK_DEPS_WEBHOOK_URL  Optional Slack incoming webhook
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { buildPlan, formatPlanSummary, normalizeAlerts, normalizeAuditReport } from './planner.mjs';
import {
  checkOverrideRemovable,
  fetchDependabotAlerts,
  fetchPackument,
  readAuditCiConfig,
  readConsumerExceptions,
  readWorkspaceConfig,
  runPnpmAudit,
} from './io.mjs';
import { createGitHubOps, createGitOps, executeActions, prepareActions } from './executor.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');

const MAX_OVERRIDE_CHECKS = 5;

const { values: flags } = parseArgs({
  options: {
    mode: { type: 'string', default: process.env.DEPS_BOT ?? 'dry-run' },
    source: { type: 'string', default: 'auto' },
    output: { type: 'string', default: '/tmp/deps-plan' },
    input: { type: 'string', default: '/tmp/deps-plan' },
  },
  strict: false,
});

const mode = flags.mode;
if (mode === 'off') {
  process.stdout.write('DEPS_BOT is off; exiting.\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Execute mode: read prepared patches and create PRs
// ---------------------------------------------------------------------------

if (mode === 'execute') {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY ?? 'bobsled-inc/dogsled-core';

  if (!token) {
    process.stderr.write('GITHUB_TOKEN is required for execute mode.\n');
    process.exitCode = 1;
  } else {
    const gitOps = createGitOps(repoRoot, token, repo);
    const githubOps = createGitHubOps(token, repo);

    executeActions(flags.input, gitOps, githubOps)
      .then((results) => {
        const opened = results.filter((r) => !r.skipped);
        const skipped = results.filter((r) => r.skipped);
        process.stdout.write(`Done: ${opened.length} PR(s) opened, ${skipped.length} skipped.\n`);
      })
      .catch((error) => {
        process.stderr.write(`${error.stack ?? error.message}\n`);
        process.exitCode = 1;
      });
  }
} else {
  // ---------------------------------------------------------------------------
  // Plan / dry-run / prepare modes
  // ---------------------------------------------------------------------------

  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}

async function sendSlackAlerts(plan) {
  const slackUrl = process.env.SLACK_DEPS_WEBHOOK_URL;
  const alertItems = plan.actions.filter(
    (a) => a.kind === 'no-fix' || a.kind === 'deadline-warning' || a.kind === 'consumer-alert'
  );
  if (alertItems.length === 0) return;
  if (!slackUrl) {
    process.stdout.write('SLACK_DEPS_WEBHOOK_URL is not set; skipping Slack notification.\n');
    return;
  }
  const lines = ['*Dependency maintenance bot*\n'];
  for (const a of alertItems) {
    if (a.kind === 'no-fix') {
      lines.push(`No fix for \`${a.package}\` (${a.ghsaId}, ${a.severity}): ${a.reason}`);
    } else if (a.kind === 'deadline-warning') {
      lines.push(
        `Deadline in ${a.daysLeft} day(s): ${a.source} ${a.advisory ?? a.key ?? ''} expires ${a.expiry}`
      );
    } else if (a.kind === 'consumer-alert') {
      const prefix = a.isLookahead ? '(look-ahead) ' : '';
      lines.push(
        `${prefix}Consumer audit: unhandled \`${a.package}\` (${a.advisory}) via ${a.path}`
      );
    }
  }
  try {
    await fetch(slackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: lines.join('\n') }),
    });
    process.stdout.write('Slack notification sent.\n');
  } catch (error) {
    process.stdout.write(`Slack notification failed: ${error.message}\n`);
  }
}

async function main() {
  const config = readWorkspaceConfig(repoRoot);
  const auditCiAllowlist = readAuditCiConfig(repoRoot);
  const consumerExceptions = readConsumerExceptions(repoRoot);

  process.stdout.write(
    `Release-age policy: ${config.releaseAgeMinutes} minutes (${Math.round(config.releaseAgeMinutes / 60 / 24)} days)\n`
  );
  process.stdout.write(`Exemptions: ${config.exemptions.length}\n`);
  process.stdout.write(`Overrides: ${Object.keys(config.overrides).length}\n`);

  let advisories = [];
  let advisorySource = 'none';

  const token = process.env.GITHUB_TOKEN ?? null;
  const repo = process.env.GITHUB_REPOSITORY ?? 'bobsled-inc/dogsled-core';
  const [owner, repoName] = repo.split('/');

  // --- Fetch advisories ---

  if (flags.source !== 'audit' && token) {
    try {
      process.stdout.write('Fetching Dependabot alerts...\n');
      const alerts = await fetchDependabotAlerts(owner, repoName, token);
      advisories = normalizeAlerts(alerts);
      advisorySource = 'Dependabot alerts API';
      process.stdout.write(`Found ${advisories.length} open advisory/advisories.\n`);
    } catch (error) {
      process.stdout.write(`Dependabot alerts unavailable: ${error.message}\n`);
      process.stdout.write('Falling back to pnpm audit.\n');
    }
  }

  if (advisories.length === 0 && flags.source !== 'alerts') {
    try {
      process.stdout.write('Running pnpm audit...\n');
      const auditJson = runPnpmAudit(repoRoot);
      const packageNames = new Set();
      if (auditJson?.advisories) {
        for (const a of Object.values(auditJson.advisories)) {
          if (a.module_name) packageNames.add(a.module_name);
        }
      }
      if (auditJson?.vulnerabilities) {
        for (const name of Object.keys(auditJson.vulnerabilities)) packageNames.add(name);
      }

      const auditPackuments = new Map();
      for (const name of packageNames) {
        try {
          auditPackuments.set(name, await fetchPackument(name));
        } catch {
          process.stdout.write(`Could not fetch packument for ${name}; skipping.\n`);
        }
      }

      advisories = normalizeAuditReport(auditJson, auditPackuments);
      advisorySource = 'pnpm audit (fallback)';
      process.stdout.write(`Found ${advisories.length} advisory/advisories from pnpm audit.\n`);
    } catch (error) {
      process.stdout.write(`pnpm audit failed: ${error.message}\n`);
      advisorySource = 'none (both sources failed)';
    }
  }

  // --- Fetch packuments for all relevant packages ---

  const exemptionPackageNames = new Set(config.exemptions.map((e) => e.name));
  const allPackageNames = new Set([...advisories.map((a) => a.package), ...exemptionPackageNames]);

  process.stdout.write(`Fetching packuments for ${allPackageNames.size} package(s)...\n`);
  const packuments = new Map();
  for (const name of allPackageNames) {
    try {
      packuments.set(name, await fetchPackument(name));
    } catch {
      process.stdout.write(`Could not fetch packument for ${name}; skipping.\n`);
    }
  }

  // --- Check overrides for removability (capped) ---

  const overrideResults = [];
  if (mode !== 'dry-run') {
    const overrideEntries = Object.entries(config.overrides);
    const toCheck = overrideEntries.slice(0, MAX_OVERRIDE_CHECKS);
    if (toCheck.length > 0) {
      process.stdout.write(`Checking ${toCheck.length} override(s) for removability...\n`);
    }
    for (const [name, version] of toCheck) {
      const cleanVersion = String(version).trim();
      try {
        const result = await checkOverrideRemovable(repoRoot, name, cleanVersion);
        overrideResults.push(result);
      } catch {
        process.stdout.write(`Override check failed for ${name}; skipping.\n`);
      }
    }
  }

  // --- Build plan ---

  const plan = buildPlan({
    advisories,
    exemptions: config.exemptions,
    packuments,
    releaseAgeMinutes: config.releaseAgeMinutes,
    auditCiAllowlist,
    consumerExceptions,
    overrideResults,
    now: Date.now(),
  });

  const summary = formatPlanSummary(plan, advisorySource);
  process.stdout.write('\n');
  process.stdout.write(summary);
  process.stdout.write('\n');

  const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummaryPath) {
    writeFileSync(stepSummaryPath, summary, { flag: 'a' });
  }

  // --- Write plan JSON to file (S2: not parsed from stdout) ---

  const outputDir = flags.output;
  mkdirSync(outputDir, { recursive: true });
  const planPath = path.join(outputDir, 'plan.json');

  // Merge consumer audit actions if consumer-check ran (both dry-run and prepare)
  const consumerActionsPath = path.join(outputDir, 'consumer-actions.json');
  if (existsSync(consumerActionsPath)) {
    const consumerActions = JSON.parse(readFileSync(consumerActionsPath, 'utf8'));
    if (consumerActions.length > 0) {
      process.stdout.write(
        `Merging ${consumerActions.length} consumer audit action(s) into plan.\n`
      );
      plan.actions.push(...consumerActions);
      plan.summary.updateException = consumerActions.filter(
        (a) => a.kind === 'update-exception'
      ).length;
      plan.summary.consumerAlert = consumerActions.filter(
        (a) => a.kind === 'consumer-alert'
      ).length;
    }
  }

  writeFileSync(planPath, JSON.stringify(plan, null, 2));
  process.stdout.write(`\nPlan written to ${planPath}\n`);

  // Re-render summary with consumer actions included
  if (plan.summary.updateException || plan.summary.consumerAlert) {
    const fullSummary = formatPlanSummary(plan, advisorySource);
    process.stdout.write('\n');
    process.stdout.write(fullSummary);
    process.stdout.write('\n');
    if (stepSummaryPath) {
      writeFileSync(stepSummaryPath, fullSummary);
    }
  }

  // Send Slack for alertable items in any mode (dry-run or prepare)
  await sendSlackAlerts(plan);

  if (mode === 'dry-run') {
    process.stdout.write('Dry-run mode: no patches or PRs will be created.\n');
    process.stdout.write(JSON.stringify(plan, null, 2));
    process.stdout.write('\n');
    return;
  }

  if (mode === 'prepare') {
    process.stdout.write('Preparing patches...\n');
    const prepared = prepareActions(plan, repoRoot, outputDir);
    const withPatch = prepared.filter((p) => !p.empty);
    process.stdout.write(
      `Prepared ${withPatch.length} patch(es) (${prepared.length - withPatch.length} empty, skipped).\n`
    );
    return;
  }
}
