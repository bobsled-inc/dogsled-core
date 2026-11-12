import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export const CONTEXT_SCHEMA_VERSION = 1;

export class AgentContextError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'AgentContextError';
    this.details = details;
  }
}

const ROUTES = [
  {
    match: /^\.agents\/|^packages\/skills\//,
    skills: ['dogsled-publish-skill'],
    risks: ['generated_manifest'],
    checks: [
      'pnpm --filter @bobsled-inc/skills generate:manifest',
      'pnpm --filter @bobsled-inc/skills test:unit',
      'pnpm docs:ci',
      'pnpm test:structural',
    ],
  },
  {
    match: /^packages\/extractor\//,
    skills: ['extractor'],
    risks: ['network_input'],
  },
  {
    match: /^packages\/integrations\//,
    skills: ['add-integration'],
    risks: ['network_input'],
  },
  {
    match: /^packages\/loader\//,
    skills: ['loader'],
    risks: ['data_destination'],
  },
  {
    match: /^packages\/model-spec\//,
    skills: ['dogsled-model-spec-edit', 'lineage'],
    risks: ['public_contract'],
  },
  {
    match: /^packages\/entity-graph\//,
    skills: ['entity-graph-resolve'],
    risks: ['privacy'],
  },
  {
    match: /^packages\/sdk-codegen\//,
    skills: ['sdk-codegen'],
    risks: ['generated_output', 'public_contract'],
  },
  {
    match: /^apps\/explorer\//,
    skills: ['explorer-dev'],
  },
  {
    match: /^\.github\/|(?:^|\/)(?:workflow|action)(?:s)?(?:\/|\.|-)/i,
    skills: ['open-source-security-review'],
    risks: ['workflow_permissions'],
    checks: ['pnpm security:fast', 'pnpm test:structural'],
  },
  {
    match: /(?:auth|oauth|credential|secret|token|redact|header)/i,
    skills: ['open-source-security-review'],
    risks: ['credentials'],
    checks: ['pnpm security:fast'],
  },
  {
    match: /(?:http|network|ssrf|redirect|dns|webhook|mcp-transport)/i,
    skills: ['open-source-security-review'],
    risks: ['network_input'],
    checks: ['pnpm security:fast'],
  },
  {
    match: /(?:path|filesystem|archive|temporary|temp-file|symlink)/i,
    skills: ['open-source-security-review'],
    risks: ['filesystem_input'],
    checks: ['pnpm security:fast'],
  },
  {
    match: /(?:subprocess|child-process|command-registry|exec|spawn)/i,
    skills: ['open-source-security-review'],
    risks: ['subprocess'],
    checks: ['pnpm security:fast'],
  },
  {
    match: /(?:privacy|telemetry|analytics|support-bundle|logging)/i,
    skills: ['open-source-security-review'],
    risks: ['privacy'],
    checks: ['pnpm security:fast'],
  },
  {
    match: /(?:^|\/)(?:package\.json|pnpm-lock\.yaml)$|(?:^|\/)(?:exports|index)\.(?:ts|js)$/i,
    risks: ['packaging', 'public_contract'],
    checks: ['pnpm security:fast'],
  },
  {
    match: /^(?:docs\/|README\.md$|AGENTS\.md$)|\.md$/i,
    checks: ['pnpm docs:ci'],
  },
];

function runGit(repoRoot, args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr =
      typeof error?.stderr === 'string' && error.stderr.trim()
        ? error.stderr.trim().split('\n').at(-1)
        : undefined;
    throw new AgentContextError(`Git discovery failed for: git ${args.join(' ')}`, [
      stderr ?? 'Git returned a non-zero exit status.',
    ]);
  }
}

export function normalizeRepoPath(repoRoot, candidate) {
  if (/[\u0000-\u001f\u007f]/.test(candidate)) {
    throw new AgentContextError('Repository paths containing control characters are unsupported.');
  }
  const absolute = path.resolve(repoRoot, candidate);
  const relative = path.relative(repoRoot, absolute);
  if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new AgentContextError(`Path is outside the repository: ${candidate}`);
  }
  return relative.split(path.sep).join('/');
}

export function parseNameStatus(output) {
  const tokens = output.split('\0').filter(Boolean);
  const paths = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!status) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = tokens[index++];
      const newPath = tokens[index++];
      if (oldPath) paths.push(oldPath);
      if (newPath) paths.push(newPath);
      continue;
    }
    const filePath = tokens[index++];
    if (filePath) paths.push(filePath);
  }
  return paths;
}

function sortedUnique(values) {
  return [...new Set(values)].sort(compareText);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function discoverChangedPaths({ repoRoot, baseRef = 'origin/main', staged = false }) {
  if (staged) {
    return {
      baseRef: null,
      mode: 'staged',
      paths: sortedUnique(
        parseNameStatus(
          runGit(repoRoot, ['diff', '--cached', '--name-status', '-z', '--find-renames'])
        )
      ),
    };
  }

  if (baseRef.startsWith('-') || /[\u0000-\u001f\u007f]/.test(baseRef)) {
    throw new AgentContextError('Base ref must be a safe Git revision without control characters.');
  }
  runGit(repoRoot, ['rev-parse', '--verify', baseRef]);
  const mergeBase = runGit(repoRoot, ['merge-base', baseRef, 'HEAD']).trim();
  if (!mergeBase) {
    throw new AgentContextError(`Could not determine a merge base for ${baseRef} and HEAD.`);
  }

  const committed = parseNameStatus(
    runGit(repoRoot, ['diff', '--name-status', '-z', '--find-renames', `${mergeBase}...HEAD`])
  );
  const working = parseNameStatus(
    runGit(repoRoot, ['diff', '--name-status', '-z', '--find-renames', 'HEAD'])
  );
  const untracked = runGit(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean);

  return {
    baseRef,
    mergeBase,
    mode: 'diff',
    paths: sortedUnique([...committed, ...working, ...untracked]),
  };
}

function readSkillMetadata(repoRoot) {
  const skillsRoot = path.join(repoRoot, '.agents', 'skills');
  if (!existsSync(skillsRoot)) {
    throw new AgentContextError('Canonical skill directory is missing: .agents/skills');
  }

  const skills = new Map();
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(skillsRoot, entry.name, 'SKILL.md');
    if (!existsSync(skillPath)) continue;
    const raw = readFileSync(skillPath, 'utf8');
    const match = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!match) continue;
    const metadata = parseYaml(match[1] ?? '') ?? {};
    skills.set(entry.name, {
      description: typeof metadata.description === 'string' ? metadata.description : '',
      name: entry.name,
      path: `.agents/skills/${entry.name}/SKILL.md`,
    });
  }
  return skills;
}

function listWorkspaces(repoRoot) {
  const workspaces = [];
  for (const parent of ['packages', 'apps']) {
    const parentPath = path.join(repoRoot, parent);
    if (!existsSync(parentPath)) continue;
    for (const entry of readdirSync(parentPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const relativePath = `${parent}/${entry.name}`;
      const manifestPath = path.join(repoRoot, relativePath, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      workspaces.push({
        name: typeof manifest.name === 'string' ? manifest.name : entry.name,
        path: relativePath,
      });
    }
  }
  return workspaces.sort((left, right) => compareText(left.path, right.path));
}

function nearestGuide(repoRoot, relativePath) {
  let current = path.dirname(path.join(repoRoot, relativePath));
  while (current.startsWith(repoRoot) && current !== repoRoot) {
    const candidate = path.join(current, 'AGENTS.md');
    if (existsSync(candidate)) {
      return path.relative(repoRoot, candidate).split(path.sep).join('/');
    }
    current = path.dirname(current);
  }
  return null;
}

export function buildAgentContext({ repoRoot, discovery }) {
  const changedPaths = sortedUnique(
    discovery.paths.map((candidate) => normalizeRepoPath(repoRoot, candidate))
  );
  const availableSkills = readSkillMetadata(repoRoot);
  const workspaces = listWorkspaces(repoRoot);
  const affectedWorkspaces = workspaces.filter((workspace) =>
    changedPaths.some(
      (filePath) => filePath === workspace.path || filePath.startsWith(`${workspace.path}/`)
    )
  );

  const guideReasons = new Map([['AGENTS.md', 'Repository-wide rules']]);
  const skillReasons = new Map();
  const riskReasons = new Map();
  const checkReasons = new Map();
  const warnings = [];

  for (const filePath of changedPaths) {
    const guide = nearestGuide(repoRoot, filePath);
    if (guide) guideReasons.set(guide, `Applies to ${filePath}`);

    for (const route of ROUTES) {
      if (!route.match.test(filePath)) continue;
      for (const skill of route.skills ?? []) {
        if (!skillReasons.has(skill)) skillReasons.set(skill, `Relevant to ${filePath}`);
      }
      for (const risk of route.risks ?? []) {
        if (!riskReasons.has(risk)) riskReasons.set(risk, `Detected from ${filePath}`);
      }
      for (const command of route.checks ?? []) {
        if (!checkReasons.has(command)) checkReasons.set(command, `Required by ${filePath}`);
      }
    }
  }

  for (const workspace of affectedWorkspaces) {
    checkReasons.set(
      `pnpm --filter ${workspace.name} typecheck`,
      `Typecheck affected workspace ${workspace.name}`
    );
    checkReasons.set(
      `pnpm --filter ${workspace.name} test:unit`,
      `Test affected workspace ${workspace.name}`
    );
  }

  const skills = [];
  for (const [name, reason] of [...skillReasons].sort(([left], [right]) =>
    compareText(left, right)
  )) {
    const skill = availableSkills.get(name);
    if (!skill) {
      warnings.push(`Routing requested missing skill: ${name}`);
      continue;
    }
    skills.push({ ...skill, reason });
  }

  return {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    discovery: {
      mode: discovery.mode,
      baseRef: discovery.baseRef ?? null,
      mergeBase: discovery.mergeBase ?? null,
    },
    changedPaths,
    guides: [...guideReasons]
      .map(([guidePath, reason]) => ({ path: guidePath, reason }))
      .sort((left, right) => compareText(left.path, right.path)),
    skills,
    workspaces: affectedWorkspaces,
    riskSurfaces: [...riskReasons]
      .map(([name, reason]) => ({ name, reason }))
      .sort((left, right) => compareText(left.name, right.name)),
    checks: {
      focused: [...checkReasons]
        .map(([command, reason]) => ({ command, reason }))
        .sort((left, right) => compareText(left.command, right.command)),
      final: [{ command: 'pnpm precommit', reason: 'Required repository gate' }],
    },
    warnings: sortedUnique(warnings),
  };
}

export function renderContextText(context) {
  const lines = [
    `Agent context (${context.discovery.mode})`,
    context.changedPaths.length
      ? `Changed paths: ${context.changedPaths.length}`
      : 'Changed paths: none',
    '',
    'Guides:',
    ...context.guides.map((guide) => `- ${guide.path} — ${guide.reason}`),
  ];

  if (context.skills.length) {
    lines.push(
      '',
      'Skills:',
      ...context.skills.map((skill) => `- ${skill.path} — ${skill.reason}`)
    );
  }
  if (context.riskSurfaces.length) {
    lines.push(
      '',
      'Risk surfaces:',
      ...context.riskSurfaces.map((risk) => `- ${risk.name} — ${risk.reason}`)
    );
  }
  if (context.checks.focused.length) {
    lines.push(
      '',
      'Focused checks:',
      ...context.checks.focused.map((check) => `- ${check.command} — ${check.reason}`)
    );
  }
  lines.push('', 'Final check:', '- pnpm precommit — Required repository gate');
  if (context.warnings.length) {
    lines.push('', 'Warnings:', ...context.warnings.map((warning) => `- ${warning}`));
  }
  return `${lines.join('\n')}\n`;
}

export function serializeContext(context, format) {
  if (format === 'json') return `${JSON.stringify(context, null, 2)}\n`;
  if (format === 'yaml') return stringifyYaml(context, { lineWidth: 100 });
  return renderContextText(context);
}
