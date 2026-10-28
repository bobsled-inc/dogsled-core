import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { normalizeToolOutput } from './adapters.mjs';
import {
  createFinding,
  parseArgs,
  readJson,
  resolveRunDir,
  sha256File,
  writeJson,
} from './lib.mjs';

const args = parseArgs();
const runDir = resolveRunDir(args);
const runPath = path.join(runDir, 'run.json');
const run = readJson(runPath);
const triagePath = args.triage ? path.resolve(args.triage) : path.join(runDir, 'triage.json');
const triage = existsSync(triagePath) ? readJson(triagePath) : { findings: {} };
const allowedClassifications = new Set(['confirmed', 'likely', 'uncertain', 'false_positive']);
const allowedDispositions = new Set(['fixed', 'accepted', 'deferred', 'not_applicable']);

function applyTriage(finding) {
  const update = triage.findings?.[finding.fingerprint];
  if (!update) return finding;
  if (update.classification && !allowedClassifications.has(update.classification)) {
    throw new Error(`Invalid classification for ${finding.fingerprint}`);
  }
  if (update.disposition && !allowedDispositions.has(update.disposition)) {
    throw new Error(`Invalid disposition for ${finding.fingerprint}`);
  }
  if (
    ['accepted', 'not_applicable'].includes(update.disposition) &&
    !String(update.codexRationale ?? '').trim()
  ) {
    throw new Error(`${update.disposition} finding ${finding.fingerprint} requires codexRationale`);
  }
  if (update.classification === 'false_positive' && !String(update.codexRationale ?? '').trim()) {
    throw new Error(`False positive ${finding.fingerprint} requires codexRationale`);
  }
  return {
    ...finding,
    ...update,
    fingerprint: finding.fingerprint,
    schemaVersion: finding.schemaVersion,
  };
}

const stages = {};
const allFindings = [];
for (const [stageName, stage] of Object.entries(run.stages)) {
  const commands = [];
  for (const command of stage.commands) {
    const stdoutPath = path.join(runDir, 'raw', command.stdoutPath);
    const stderrPath = path.join(runDir, 'raw', command.stderrPath);
    let parseStatus = 'not-run';
    let parseError = '';
    let findings = [];

    if (command.status === 'unavailable') {
      parseStatus = 'unavailable';
    } else if (!existsSync(stdoutPath) || !existsSync(stderrPath)) {
      parseStatus = 'missing-evidence';
    } else {
      try {
        findings = normalizeToolOutput(command.adapter, readFileSync(stdoutPath, 'utf8'), {
          tool: command.tool,
          stage: stageName,
        });
        if (command.status === 'findings' && findings.length === 0) {
          throw new Error('Tool exited with findings status but produced no normalized findings.');
        }
        parseStatus = 'parsed';
      } catch (error) {
        parseStatus = 'invalid';
        parseError = error instanceof Error ? error.message : String(error);
      }
    }

    const normalizedFindings = findings.map((finding) => ({
      ...applyTriage(finding),
      stage: stageName,
      commandId: command.id,
    }));
    allFindings.push(...normalizedFindings);
    commands.push({
      ...command,
      parseStatus,
      parseError,
      findingCount: normalizedFindings.length,
      evidenceValid:
        existsSync(stdoutPath) &&
        existsSync(stderrPath) &&
        sha256File(stdoutPath) === command.stdoutSha256 &&
        sha256File(stderrPath) === command.stderrSha256,
    });
  }

  stages[stageName] = {
    commands,
    status: commands.every(
      (entry) =>
        ['passed', 'findings'].includes(entry.status) &&
        entry.parseStatus === 'parsed' &&
        entry.evidenceValid
    )
      ? 'complete'
      : 'incomplete',
  };
}

for (const resolved of triage.resolvedFindings ?? []) {
  if (resolved.disposition !== 'fixed' || !Array.isArray(resolved.verification)) {
    throw new Error('Supplemental resolved findings must be fixed and include verification.');
  }
  allFindings.push({
    ...createFinding(resolved),
    stage: 'remediation',
    commandId: 'codex-remediation-record',
  });
}

const byFingerprint = new Map();
for (const finding of allFindings) {
  const existing = byFingerprint.get(finding.fingerprint);
  if (!existing) {
    byFingerprint.set(finding.fingerprint, {
      ...finding,
      detectedBy: [finding.tool],
      occurrences: [
        { stage: finding.stage, commandId: finding.commandId, location: finding.location },
      ],
    });
    continue;
  }
  existing.detectedBy = [...new Set([...existing.detectedBy, finding.tool])].sort();
  existing.occurrences.push({
    stage: finding.stage,
    commandId: finding.commandId,
    location: finding.location,
  });
  if (finding.severity < existing.severity) existing.severity = finding.severity;
}

const normalized = {
  schemaVersion: 1,
  runId: run.runId,
  repositoryCommit: run.repositoryCommit,
  publicationModel: run.publicationModel,
  privateHistoryWillRemainPrivate: run.privateHistoryWillRemainPrivate,
  stages,
  findings: [...byFingerprint.values()].sort((left, right) =>
    `${left.severity}:${left.rootCause}:${left.fingerprint}`.localeCompare(
      `${right.severity}:${right.rootCause}:${right.fingerprint}`
    )
  ),
};
writeJson(path.join(runDir, 'normalized.json'), normalized);
process.stdout.write(`${path.join(runDir, 'normalized.json')}\n`);
if (Object.values(stages).some((stage) => stage.status === 'incomplete')) process.exitCode = 2;
