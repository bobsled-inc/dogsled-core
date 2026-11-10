#!/usr/bin/env node

/**
 * Consumer audit wrapper for the dependency maintenance bot.
 *
 * Builds the packed tarball, runs the consumer audit at the current cutoff
 * and again with a 3-day look-ahead, classifies unhandled findings as
 * stale-exception or new-finding, and writes the resulting actions to the
 * output directory.
 *
 * Usage:
 *   node scripts/deps/consumer-check.mjs --output /tmp/deps-plan [--lookahead-days 3]
 *
 * The output directory receives:
 *   consumer-actions.json   Array of plan actions
 *   consumer-report.json    Full audit results
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { auditPackedConsumers } from '../security/consumer-audit.mjs';
import { explainPaths, validateConsumerExceptions } from '../security/consumer-policy.mjs';
import { stageDogsledPackage } from '../release/stage-package.mjs';
import { repoRoot } from '../security/lib.mjs';
import { buildConsumerAuditActions } from './planner.mjs';

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';

const DAY_MS = 24 * 60 * 60 * 1000;

const { values: flags } = parseArgs({
  options: {
    output: { type: 'string', default: '/tmp/deps-plan' },
    'lookahead-days': { type: 'string', default: '3' },
  },
  strict: false,
});

const lookaheadDays = Number(flags['lookahead-days']);
const outputDir = flags.output;

async function main() {
  mkdirSync(outputDir, { recursive: true });

  // --- Build the packed tarball ---
  process.stdout.write('Staging and packing the Dogsled tarball...\n');
  const stageRoot = mkdtempSync(path.join(os.tmpdir(), 'deps-bot-stage-'));
  const stageDir = path.join(stageRoot, 'package');
  let tarball;
  try {
    stageDogsledPackage(stageDir);
    const tarballDir = path.join(stageRoot, 'tarballs');
    mkdirSync(tarballDir, { recursive: true });
    const packOutput = execFileSync('npm', ['pack', '--pack-destination', tarballDir], {
      cwd: stageDir,
      encoding: 'utf8',
      timeout: 5 * 60_000,
    });
    tarball = path.join(tarballDir, packOutput.trim().split(/\r?\n/).at(-1));
    process.stdout.write(`Packed: ${tarball}\n`);
  } catch (error) {
    process.stderr.write(`Tarball build failed: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  const exceptions = validateConsumerExceptions(
    JSON.parse(
      readFileSync(path.join(repoRoot, 'scripts', 'security', 'consumer-exceptions.json'), 'utf8')
    )
  );

  // --- Current audit ---
  process.stdout.write('Running consumer audit (current cutoff)...\n');
  const currentReport = await auditPackedConsumers({
    tarball,
    outputDir: path.join(outputDir, 'consumer-current'),
    repoRoot,
  });

  // --- Look-ahead audit ---
  const lookaheadNow = Date.now() + lookaheadDays * DAY_MS;
  process.stdout.write(
    `Running consumer audit (${lookaheadDays}-day look-ahead, cutoff as of ${new Date(lookaheadNow).toISOString()})...\n`
  );
  let lookaheadReport;
  try {
    lookaheadReport = await auditPackedConsumers({
      tarball,
      outputDir: path.join(outputDir, 'consumer-lookahead'),
      repoRoot,
      now: lookaheadNow,
    });
  } catch (error) {
    process.stdout.write(`Look-ahead audit failed (non-blocking): ${error.message}\n`);
    lookaheadReport = { passed: true, results: [] };
  }

  rmSync(stageRoot, { recursive: true, force: true });

  // --- Classify findings ---
  const now = Date.now();
  const allActions = [];

  for (const result of currentReport.results) {
    const unhandled = result.findings.filter((f) => f.disposition === 'unhandled');
    if (unhandled.length === 0) continue;

    const parentVersionMap = buildParentVersionMap(
      unhandled,
      path.join(outputDir, 'consumer-current', result.mode)
    );
    allActions.push(
      ...buildConsumerAuditActions(unhandled, parentVersionMap, exceptions, false, now)
    );
  }

  for (const result of lookaheadReport.results) {
    const unhandled = result.findings.filter((f) => f.disposition === 'unhandled');
    if (unhandled.length === 0) continue;

    const parentVersionMap = buildParentVersionMap(
      unhandled,
      path.join(outputDir, 'consumer-lookahead', result.mode)
    );
    allActions.push(
      ...buildConsumerAuditActions(unhandled, parentVersionMap, exceptions, true, now)
    );
  }

  // --- Write results ---
  writeFileSync(path.join(outputDir, 'consumer-actions.json'), JSON.stringify(allActions, null, 2));
  writeFileSync(
    path.join(outputDir, 'consumer-report.json'),
    JSON.stringify(
      {
        current: { passed: currentReport.passed, resultCount: currentReport.results.length },
        lookahead: {
          passed: lookaheadReport.passed,
          resultCount: lookaheadReport.results.length,
        },
        actions: allActions.length,
      },
      null,
      2
    )
  );

  process.stdout.write(
    `Consumer audit complete: ${allActions.length} action(s) (${allActions.filter((a) => a.kind === 'update-exception').length} stale, ${allActions.filter((a) => a.kind === 'consumer-alert').length} new).\n`
  );

  if (!currentReport.passed) {
    process.stdout.write('Current consumer audit has unhandled findings.\n');
    process.exitCode = 1;
  }
}

/**
 * Extract actual parent versions from the explanations evidence for each
 * unhandled finding. Returns a map: "advisory:package:version:path" -> { parent: actualVersion }.
 */
function buildParentVersionMap(findings, evidenceDir) {
  const map = {};
  try {
    const explanations = JSON.parse(
      readFileSync(path.join(evidenceDir, 'explanations.json'), 'utf8')
    );
    for (const finding of findings) {
      const explanation = explanations[finding.location];
      if (!explanation?.length) continue;
      for (const node of explanation) {
        if (node.location !== finding.location) continue;
        const paths = explainPaths([node], finding.package, true);
        const match = paths.find((p) => p.path === finding.path);
        if (match) {
          const key = `${finding.advisory}:${finding.package}:${finding.version}:${finding.path}`;
          map[key] = match.versions;
          break;
        }
      }
    }
  } catch {
    /* evidence may be unavailable; classification still works without versions */
  }
  return map;
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
