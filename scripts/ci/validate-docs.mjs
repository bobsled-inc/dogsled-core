import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  isConcreteDocToken,
  isPackageRelativeToken,
  isRepoRelativeToken,
  listWorkspacePackages,
  normalizeDocToken,
  parseLastReviewed,
  pathExists,
  relativeToRepo,
  repoRoot,
  rootAgentsPath,
} from './shared.mjs';

const MAX_DOC_AGE_DAYS = 120;
const jsonMode = process.argv.includes('--json');
const violations = [];

function addViolation(message) {
  violations.push(message);
}

function extractBacktickTokens(text) {
  const tokens = [];
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    tokens.push(match[1]);
  }
  return tokens;
}

function extractPathLikeLines(text) {
  const tokens = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      continue;
    }
    const candidate = trimmed.split(/\s+#/)[0]?.trim();
    if (!candidate || candidate.includes(' ')) {
      continue;
    }
    if (
      candidate.startsWith('src/') ||
      candidate.startsWith('tests/') ||
      candidate.startsWith('integrations/')
    ) {
      tokens.push(candidate);
    }
  }
  return tokens;
}

function validateMetadata(docPath) {
  const content = readFileSync(docPath, 'utf8');
  const lastReviewed = parseLastReviewed(content);
  if (!lastReviewed) {
    addViolation(`${relativeToRepo(docPath)} is missing a last-reviewed metadata comment.`);
    return content;
  }

  const daysOld = Math.floor(
    (Date.now() - new Date(`${lastReviewed}T00:00:00Z`).getTime()) / (1000 * 60 * 60 * 24)
  );
  if (daysOld > MAX_DOC_AGE_DAYS) {
    addViolation(
      `${relativeToRepo(docPath)} was last reviewed on ${lastReviewed} (${daysOld} days ago). Refresh it before agents rely on it.`
    );
  }

  return content;
}

function validateRepoReferences(docPath, content) {
  const tokens = extractBacktickTokens(content)
    .map(normalizeDocToken)
    .filter((token) => isConcreteDocToken(token))
    .filter((token) => isRepoRelativeToken(token));

  for (const token of tokens) {
    const absolutePath = path.join(repoRoot, token);
    if (!pathExists(absolutePath)) {
      addViolation(`${relativeToRepo(docPath)} references missing path ${token}.`);
    }
  }
}

function validatePackageDoc(pkg) {
  const content = validateMetadata(pkg.agentsPath);
  const headingMatch = content.match(/^#\s+([^\n—]+?)\s+—/m);
  if (!headingMatch) {
    addViolation(`${relativeToRepo(pkg.agentsPath)} is missing the standard package heading.`);
  } else if (headingMatch[1].trim() !== pkg.name) {
    addViolation(
      `${relativeToRepo(pkg.agentsPath)} heading "${headingMatch[1].trim()}" does not match package name "${pkg.name}".`
    );
  }

  const tokens = [...extractBacktickTokens(content), ...extractPathLikeLines(content)]
    .map(normalizeDocToken)
    .filter((token) => isConcreteDocToken(token))
    .filter((token) => isPackageRelativeToken(token));

  for (const token of tokens) {
    const absolutePath = path.join(pkg.dir, token);
    if (!pathExists(absolutePath)) {
      addViolation(
        `${relativeToRepo(pkg.agentsPath)} references missing path ${relativeToRepo(absolutePath)}.`
      );
    }
  }
}

function readRepoText(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!pathExists(absolutePath)) {
    addViolation(`Entity graph docs drift guard could not find ${relativePath}.`);
    return '';
  }
  return readFileSync(absolutePath, 'utf8');
}

function validateEntityGraphSdkDocsDrift() {
  const driftFiles = [
    'README.md',
    'AGENTS.md',
    'docs/getting-started.md',
    'docs/guides/learn-and-examples.md',
    'docs/guides/entity-graph.md',
    'docs/reference/advanced/mention-extraction.md',
    'docs/reference/advanced/relationship-extraction.md',
    'docs/reference/advanced/sdk-codegen.md',
    'examples/entity-resolution-sdk/README.md',
    'apps/explorer/src/lib/learn-module-entity-graph-sdk.ts',
    'packages/sdk-codegen/AGENTS.md',
    'packages/sdk-codegen/src/ir/schema.ts',
  ];

  for (const relativePath of driftFiles) {
    const content = readRepoText(relativePath);
    if (content.includes('resolve-sdk.md')) {
      addViolation(
        `${relativePath} references a deleted *-resolve-sdk.md guide. Use entity-graph.md or sdk-codegen.md.`
      );
    }
    if (content.includes('--allow-deletions')) {
      addViolation(
        `${relativePath} documents --allow-deletions, but dogsled sdk generate does not ship that flag.`
      );
    }
  }

  const overview = readRepoText('docs/guides/entity-graph.md');
  if (overview.includes('| `relationship_type`')) {
    addViolation(
      'docs/guides/entity-graph.md uses relationship_type in the public __entity_relationship schema. Use relation_type; reserve relationship_type for cardinality specs.'
    );
  }

  for (const relativePath of [
    'docs/guides/entity-graph.md',
    'docs/reference/advanced/mention-extraction.md',
    'docs/reference/advanced/relationship-extraction.md',
    'docs/reference/advanced/sdk-codegen.md',
    'apps/explorer/src/lib/learn-module-entity-graph-sdk.ts',
    '.agents/skills/entity-graph-sdk/SKILL.md',
  ]) {
    const content = readRepoText(relativePath);
    if (content.includes('bet2.')) {
      addViolation(`${relativePath} uses an unsupported doctor namespace in user-facing copy.`);
    }
  }

  const relationshipGuide = readRepoText('docs/reference/advanced/relationship-extraction.md');
  for (const required of [
    '__entity_relationship_evidence',
    '__entity_relationship_decisions',
    '__entity_relationship_edge',
    'candidate_pair_mismatch',
  ]) {
    if (!relationshipGuide.includes(required)) {
      addViolation(
        `docs/reference/advanced/relationship-extraction.md must document ${required} for entity graph drift coverage.`
      );
    }
  }

  const explorerSdkLearn = readRepoText('apps/explorer/src/lib/learn-module-entity-graph-sdk.ts');
  if (explorerSdkLearn.includes('Confidence bands align with `mdm-resolve`')) {
    addViolation(
      'apps/explorer/src/lib/learn-module-entity-graph-sdk.ts conflates extraction thresholds with review-export labels.'
    );
  }
}

const agentsContent = validateMetadata(rootAgentsPath);
validateRepoReferences(rootAgentsPath, agentsContent);

const packages = listWorkspacePackages();
for (const pkg of packages) {
  if (!pathExists(pkg.agentsPath)) {
    addViolation(`${relativeToRepo(pkg.dir)} is missing AGENTS.md.`);
    continue;
  }
  validatePackageDoc(pkg);
}
const explorerAgentsPath = path.join(repoRoot, 'apps', 'explorer', 'AGENTS.md');
if (!pathExists(explorerAgentsPath)) {
  addViolation('apps/explorer is missing AGENTS.md.');
} else {
  const explorerContent = validateMetadata(explorerAgentsPath);
  validateRepoReferences(explorerAgentsPath, explorerContent);
}
validateEntityGraphSdkDocsDrift();

const report = {
  ok: violations.length === 0,
  checkedDocs: [
    'AGENTS.md',
    ...packages.map((pkg) => `packages/${pkg.shortName}/AGENTS.md`),
    'apps/explorer/AGENTS.md',
    'Entity graph docs drift guard',
  ],
  violations,
};

if (jsonMode) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else if (violations.length === 0) {
  console.log(`Docs validation passed for ${report.checkedDocs.length} documents.`);
} else {
  console.error('Docs validation failed:');
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
}

if (violations.length > 0) {
  process.exitCode = 1;
}
