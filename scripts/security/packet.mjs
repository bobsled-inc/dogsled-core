import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseArgs, readJson, redactText, resolveRunDir } from './lib.mjs';

function findingLabel(finding) {
  const location = finding.location.path
    ? `${finding.location.path}${finding.location.line ? `:${finding.location.line}` : ''}`
    : 'repository-wide';
  return `**${finding.severity} · ${finding.rootCause}** — ${finding.message} (${location})`;
}

function commandResult(command) {
  return `${command.tool} ${command.version} — ${command.status}, ${command.parseStatus}, ${command.findingCount} finding(s)`;
}

export function recommend(normalized) {
  const incomplete = Object.values(normalized.stages).some((stage) => stage.status !== 'complete');
  const unresolvedP1 = normalized.findings.some(
    (finding) =>
      finding.severity === 'P1' &&
      !['fixed', 'not_applicable'].includes(finding.disposition) &&
      finding.classification !== 'false_positive'
  );
  const unresolvedP2 = normalized.findings.some(
    (finding) =>
      finding.severity === 'P2' &&
      !['fixed', 'accepted', 'not_applicable'].includes(finding.disposition) &&
      finding.classification !== 'false_positive'
  );
  const accepted = normalized.findings.some((finding) => finding.disposition === 'accepted');
  if (incomplete || unresolvedP1 || unresolvedP2) return 'NO-GO';
  if (accepted) return 'GO WITH ACCEPTED RISKS';
  return 'GO';
}

export function buildPacket(normalized, verification) {
  const recommendation = recommend(normalized);
  const unresolved = normalized.findings.filter(
    (finding) =>
      !['fixed', 'accepted', 'not_applicable'].includes(finding.disposition) &&
      finding.classification !== 'false_positive' &&
      ['P1', 'P2'].includes(finding.severity)
  );
  const resolved = normalized.findings.filter((finding) => finding.disposition === 'fixed');
  const dismissed = normalized.findings.filter(
    (finding) =>
      finding.classification === 'false_positive' || finding.disposition === 'not_applicable'
  );
  const accepted = normalized.findings.filter((finding) => finding.disposition === 'accepted');
  const p3 = normalized.findings.filter(
    (finding) =>
      finding.severity === 'P3' &&
      !resolved.includes(finding) &&
      finding.classification !== 'false_positive' &&
      finding.disposition !== 'not_applicable'
  );
  const completedStages = Object.entries(normalized.stages)
    .filter(([, stage]) => stage.status === 'complete')
    .map(([name]) => name);
  const incompleteStages = Object.entries(normalized.stages)
    .filter(([, stage]) => stage.status !== 'complete')
    .map(([name]) => name);
  const stagesComplete = incompleteStages.length === 0 && verification.verified;
  const staleGarFinding = normalized.findings.some(
    (finding) => finding.rootCause === 'npm-config-audit:stale-user-private-registry-auth'
  );

  const lines = [
    '# Dogsled Open-Source Security and Privacy Decision Packet',
    '',
    `## Recommendation: ${recommendation}`,
    '',
    '## Five-minute summary',
    '',
    `- Review run: \`${normalized.runId}\` against commit \`${normalized.repositoryCommit}\`.`,
    `- Publication model: clean export becomes a new public root; private source history remains private.`,
    `- Completed stages: ${completedStages.length ? completedStages.join(', ') : 'none'}.`,
    `- Incomplete stages: ${incompleteStages.length ? incompleteStages.join(', ') : 'none'}.`,
    `- Findings: ${normalized.findings.length} normalized; ${resolved.length} remediated; ${dismissed.length} dismissed with code evidence; ${unresolved.length} unresolved P1/P2; ${accepted.length} accepted risk(s).`,
    `- Evidence verification: ${verification.verified ? 'passed' : 'failed'}.`,
    '',
    '## Human decision table',
    '',
  ];

  if (unresolved.length === 0 && accepted.length === 0) {
    lines.push('No unresolved P0–P2 decision requires maintainer action.', '');
  } else {
    lines.push(
      '| Priority | Finding | Recommendation | Human decision |',
      '| --- | --- | --- | --- |'
    );
    for (const finding of [...unresolved, ...accepted]) {
      lines.push(
        `| ${finding.severity} | ${finding.message.replaceAll('|', '\\|')} | ${(finding.recommendation || 'Review disposition').replaceAll('|', '\\|')} | ${(finding.humanDecision || 'Approve, reject, or request remediation').replaceAll('|', '\\|')} |`
      );
    }
    lines.push('');
  }

  lines.push('## Resolved findings', '');
  if (resolved.length === 0) {
    lines.push('No confirmed finding was remediated during this run.', '');
  } else {
    for (const finding of resolved) {
      lines.push(`- ${findingLabel(finding)}`);
      lines.push(
        `  - Disposition: ${finding.disposition}; classification: ${finding.classification}.`
      );
      if (finding.codexRationale) lines.push(`  - Rationale: ${finding.codexRationale}`);
      if (finding.remediationCommit) {
        lines.push(`  - Remediation commit: \`${finding.remediationCommit}\`.`);
      }
      if (finding.verification.length) {
        lines.push(`  - Verification: ${finding.verification.join('; ')}`);
      }
    }
    lines.push('');
  }
  lines.push(
    `${dismissed.length} scanner matches were dismissed with repository evidence. Their detailed rationales remain in the verified local triage record and are intentionally omitted from this human decision packet.`,
    ''
  );

  lines.push(
    '## Privacy summary',
    '',
    '- Dogsled has no required hosted control plane or default maintainer telemetry.',
    '- Operator data remains local unless a configured API, warehouse, MCP server, AI provider, embedding provider, or destination receives it.',
    '- Credentials are supplied through environment indirection; local state, caches, logs, temporary files, generated workflows, and support bundles remain operator-controlled retention surfaces.',
    '- See `PRIVACY.md` for the reviewed data-flow and review-trigger policy.',
    '',
    '## Coverage and blind spots',
    ''
  );
  for (const [stageName, stage] of Object.entries(normalized.stages)) {
    lines.push(`### ${stageName} — ${stage.status}`);
    lines.push('');
    for (const command of stage.commands) lines.push(`- ${commandResult(command)}`);
    lines.push('');
  }
  if (verification.violations.length > 0) {
    lines.push('Verification gaps:', '');
    for (const violation of verification.violations) lines.push(`- ${violation}`);
    lines.push('');
  }

  lines.push(
    '## Publication checklist',
    '',
    `- [${stagesComplete ? 'x' : ' '}] All deterministic review stages complete.`,
    staleGarFinding
      ? '- [ ] Maintainer removes the retired GAR user npm configuration and confirms the credential owner action.'
      : '- [x] Retired GAR settings are absent from user npm configuration; Dogsled Next uses npmjs.org.',
    '- [ ] Final clean export is regenerated from the approved immutable commit.',
    '- [ ] Export manifest hash is recorded and the resulting public root matches it.',
    '- [ ] Maintainer approves repository promotion.',
    '',
    '## Post-launch recommendations',
    ''
  );
  if (p3.length === 0) {
    lines.push('No unresolved P3 recommendation was produced.', '');
  } else {
    for (const finding of p3) {
      lines.push(
        `- ${findingLabel(finding)} — ${finding.recommendation || 'Revisit when triggered.'}`
      );
    }
    lines.push('');
  }

  lines.push('## Evidence appendix', '');
  for (const [stageName, stage] of Object.entries(normalized.stages)) {
    for (const command of stage.commands) {
      lines.push(
        `- **${stageName}/${command.id}:** \`${redactText(command.command)}\`; ${command.startedAt} to ${command.finishedAt}; exit ${command.exitCode ?? 'unavailable'}; stdout SHA-256 \`${command.stdoutSha256}\`; stderr SHA-256 \`${command.stderrSha256}\`.`
      );
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function main() {
  const args = parseArgs();
  const runDir = resolveRunDir(args);
  const normalized = readJson(path.join(runDir, 'normalized.json'));
  const verification = readJson(path.join(runDir, 'verification.json'));
  const outputPath = args.out ? path.resolve(args.out) : path.join(runDir, 'decision-packet.md');
  writeFileSync(outputPath, buildPacket(normalized, verification));
  process.stdout.write(`${outputPath}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
