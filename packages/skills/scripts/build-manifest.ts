/**
 * Generator script for the Bobsled Core skills manifest.
 *
 * Walks `.agents/skills/<name>/SKILL.md`, filters to entries with
 * `exposed: true` in their YAML front-matter, resolves transclusion
 * markers (`{{include: <repo-relative path>}}` and
 * `{{include-section: <repo-relative path>#<heading>}}`), and writes
 * the result to `src/generated-data.ts` as a typed TypeScript constant.
 *
 * Why a generated TS file: serverless bundlers (Vercel standalone,
 * etc.) trace JS imports but not runtime `fs.readdirSync` reads. A
 * pre-baked constant makes the manifest available to every consumer
 * without bundler workarounds. Same recipe as
 * `@bobsled-inc/integrations`'s `generate-catalog-manifest.ts`.
 *
 * Run via:
 *   pnpm --filter @bobsled-inc/skills generate:manifest
 *
 * Wired into `pnpm build` so the generated file is always in sync with
 * the source skills after a build. A drift-guard test in
 * `tests/generated-data.test.ts` fails CI if the committed file falls
 * out of sync.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse as parseYaml } from 'yaml';

import { SKILLS_MANIFEST_SCHEMA_VERSION } from '../src/types.js';
import type { CatalogDefinition, SkillSummary, SkillsManifest } from '../src/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PKG_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(PKG_ROOT, '..', '..');
const SKILLS_DIR = join(REPO_ROOT, '.agents', 'skills');
const CATALOGS_DIR = join(PKG_ROOT, 'content', 'catalogs');
const OUTPUT_PATH = join(PKG_ROOT, 'src', 'generated-data.ts');
const PACKAGE_JSON = join(PKG_ROOT, 'package.json');

const HEADER = `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Regenerate with:
 *   pnpm --filter @bobsled-inc/skills generate:manifest
 *
 * The drift-guard test in \`tests/generated-data.test.ts\` fails CI if
 * this file falls out of sync with \`.agents/skills/\` or the JSON files
 * under \`content/catalogs/\`.
 */
`;

interface SkillFrontMatter {
  name?: string;
  description?: string;
  triggers?: string[];
  exposed?: boolean;
}

interface ParsedSkill {
  frontMatter: SkillFrontMatter;
  body: string;
}

const FRONT_MATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
const INCLUDE_RE = /\{\{include:\s*([^}\s][^}]*?)\s*\}\}/g;
const INCLUDE_SECTION_RE = /\{\{include-section:\s*([^#\s}]+)#([^}]+?)\s*\}\}/g;
const HEADING_RE = /^(#+)\s+(.+?)\s*$/;
const MAX_TRANSCLUSION_DEPTH = 4;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Validate parsed YAML against {@link SkillFrontMatter} and fail loudly
 * with the source path on any type mismatch.
 *
 * A typo like `exposed: "true"` (string instead of boolean) used to
 * silently drop the skill from the manifest, and a malformed
 * `triggers:` value used to silently become an empty array — both
 * exactly the kind of build-time mistake that's miserable to debug at
 * the consumer end. We surface them as build failures with a clear
 * pointer to the offending file.
 */
function normalizeFrontMatter(value: unknown, source: string): SkillFrontMatter {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object') {
    throw new Error(`${source}: front-matter must parse to a YAML mapping`);
  }
  const candidate = value as {
    name?: unknown;
    description?: unknown;
    triggers?: unknown;
    exposed?: unknown;
  };
  if (candidate.name !== undefined && typeof candidate.name !== 'string') {
    throw new Error(`${source}: front-matter "name" must be a string`);
  }
  if (candidate.description !== undefined && typeof candidate.description !== 'string') {
    throw new Error(`${source}: front-matter "description" must be a string`);
  }
  if (candidate.triggers !== undefined && !isStringArray(candidate.triggers)) {
    throw new Error(`${source}: front-matter "triggers" must be an array of strings`);
  }
  if (candidate.exposed !== undefined && typeof candidate.exposed !== 'boolean') {
    throw new Error(`${source}: front-matter "exposed" must be a boolean`);
  }
  return {
    name: candidate.name as string | undefined,
    description: candidate.description as string | undefined,
    triggers: candidate.triggers as string[] | undefined,
    exposed: candidate.exposed as boolean | undefined,
  };
}

export function parseSkill(raw: string, source = 'SKILL.md'): ParsedSkill {
  const match = raw.match(FRONT_MATTER_RE);
  if (!match) {
    throw new Error(`${source}: missing YAML front-matter delimited by ---`);
  }
  const frontMatter = normalizeFrontMatter(parseYaml(match[1] ?? ''), source);
  return { frontMatter, body: (match[2] ?? '').trimStart() };
}

/**
 * Validate parsed catalog JSON against {@link CatalogDefinition}. A
 * malformed `content/catalogs/<name>.json` (missing field, wrong
 * type) used to be silently asserted and baked into the manifest;
 * now it fails the build with a clear pointer.
 */
function parseCatalogDefinition(raw: string, source: string): CatalogDefinition {
  const parsed = JSON.parse(raw) as {
    kind?: unknown;
    description?: unknown;
    values?: unknown;
  };
  if (
    typeof parsed.kind !== 'string' ||
    typeof parsed.description !== 'string' ||
    !Array.isArray(parsed.values) ||
    parsed.values.some((v) => typeof v !== 'string')
  ) {
    throw new Error(
      `${source}: invalid catalog definition shape — expected { kind: string, description: string, values: string[] }`
    );
  }
  return {
    kind: parsed.kind,
    description: parsed.description,
    values: parsed.values as string[],
  };
}

export function slugifyHeading(heading: string): string {
  return heading
    .toLowerCase()
    .trim()
    .replace(/[`*]/g, '')
    .replace(/[^a-z0-9_\- ]/g, '')
    .replace(/\s+/g, '-');
}

export function extractSection(markdown: string, heading: string): string {
  // Match raw heading text rather than the slugified form: two
  // different headings can normalize to the same slug (e.g. "Type
  // Catalog" and "type-catalog" both slug to "type-catalog") and
  // silently selecting the wrong one would bake the wrong content
  // into the manifest. Strict equality after trimming is the safest
  // invariant — fail loudly when the marker's heading doesn't exist.
  const target = heading.trim();
  const lines = markdown.split('\n');
  let startIdx = -1;
  let startLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (typeof line !== 'string') continue;
    const m = line.match(HEADING_RE);
    if (!m) continue;
    const lvl = (m[1] ?? '').length;
    const text = (m[2] ?? '').trim();
    if (text === target) {
      startIdx = i;
      startLevel = lvl;
      break;
    }
  }
  if (startIdx === -1) {
    throw new Error(`include-section target not found: "${heading}"`);
  }
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (typeof line !== 'string') continue;
    const m = line.match(HEADING_RE);
    if (m && (m[1] ?? '').length <= startLevel) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx).join('\n').replace(/\n+$/, '');
}

/**
 * Resolve a transclusion path against the repo root and verify the
 * result stays inside the repo. Prevents `{{include: ../../etc/passwd}}`
 * (or a symlink pointing outside the workspace) from silently reading
 * files outside the repo at build time. Containment is checked
 * against canonical (symlink-resolved) paths — a lexical check alone
 * would let an in-repo symlink targeting `/etc/passwd` slip through.
 */
function resolveInsideRepo(repoRoot: string, repoRelativePath: string): string {
  const abs = resolve(repoRoot, repoRelativePath.trim());
  // realpathSync follows every symlink in the path. If the target
  // doesn't exist, the resulting ENOENT bubbles up — which is the
  // right behavior: a missing transclusion target is also bad input.
  const rootReal = realpathSync(repoRoot);
  const absReal = realpathSync(abs);
  const rel = relative(rootReal, absReal);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`transclusion path escapes repo root: "${repoRelativePath}"`);
  }
  if (!absReal.startsWith(`${rootReal}${sep}`) && absReal !== rootReal) {
    throw new Error(`transclusion path escapes repo root: "${repoRelativePath}"`);
  }
  return absReal;
}

export function resolveTransclusions(
  body: string,
  repoRoot: string = REPO_ROOT,
  transformDocument: (content: string, path: string) => string = (content) => content
): string {
  let current = body;
  for (let depth = 0; depth <= MAX_TRANSCLUSION_DEPTH; depth++) {
    let changed = false;
    // Resolve include-section first so paths containing `#` aren't
    // mis-matched by the bare include regex.
    current = current.replace(INCLUDE_SECTION_RE, (_, path: string, section: string) => {
      const abs = resolveInsideRepo(repoRoot, path);
      const content = transformDocument(readFileSync(abs, 'utf-8'), abs);
      changed = true;
      return extractSection(content, section);
    });
    current = current.replace(INCLUDE_RE, (_, path: string) => {
      const abs = resolveInsideRepo(repoRoot, path);
      const content = transformDocument(readFileSync(abs, 'utf-8'), abs);
      changed = true;
      return content.replace(/\n+$/, '');
    });
    if (!changed) return current;
  }
  throw new Error(
    `transclusion depth limit (${MAX_TRANSCLUSION_DEPTH}) exceeded — circular include?`
  );
}

function extractTitle(body: string, fallback: string): string {
  const m = body.match(/^#\s+(.+?)\s*$/m);
  return m && m[1] ? m[1] : fallback;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

interface BuildResult {
  manifest: SkillsManifest;
  bodies: Record<string, string>;
  catalogs: Record<string, CatalogDefinition>;
}

export function buildManifest(): BuildResult {
  const pkgJson = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8')) as { version: string };

  const skillDirs = readdirSync(SKILLS_DIR)
    .filter((entry) => isDirectory(join(SKILLS_DIR, entry)))
    .sort();

  const summaries: SkillSummary[] = [];
  const bodies: Record<string, string> = {};

  for (const dir of skillDirs) {
    const skillFile = join(SKILLS_DIR, dir, 'SKILL.md');
    if (!fileExists(skillFile)) continue;
    const raw = readFileSync(skillFile, 'utf-8');
    const { frontMatter, body } = parseSkill(raw, relative(REPO_ROOT, skillFile));
    if (frontMatter.exposed !== true) continue;
    const name = frontMatter.name ?? dir;
    if (name !== dir) {
      throw new Error(
        `skill front-matter name "${name}" does not match directory "${dir}" — keep them aligned`
      );
    }
    const resolved = resolveTransclusions(body);
    const hash = createHash('sha256').update(resolved).digest('hex');
    const title = extractTitle(resolved, name);
    summaries.push({
      name,
      title,
      description: frontMatter.description ?? '',
      triggers: frontMatter.triggers ?? [],
      size: Buffer.byteLength(resolved, 'utf-8'),
      hash,
    });
    bodies[name] = resolved;
  }

  summaries.sort((a, b) => a.name.localeCompare(b.name));

  const catalogs: Record<string, CatalogDefinition> = {};
  const catalogFiles = readdirSync(CATALOGS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  for (const file of catalogFiles) {
    const name = file.replace(/\.json$/, '');
    const content = readFileSync(join(CATALOGS_DIR, file), 'utf-8');
    catalogs[name] = parseCatalogDefinition(content, `content/catalogs/${file}`);
  }

  const combined = createHash('sha256');
  for (const s of summaries) combined.update(s.hash);
  for (const name of Object.keys(catalogs).sort()) {
    combined.update(name);
    combined.update(JSON.stringify(catalogs[name]));
  }
  const manifestHash = combined.digest('hex');

  const manifest: SkillsManifest = {
    schema_version: SKILLS_MANIFEST_SCHEMA_VERSION,
    version: pkgJson.version,
    hash: manifestHash,
    skills: summaries,
    catalogs: Object.keys(catalogs).sort(),
  };

  return { manifest, bodies, catalogs };
}

export function renderGeneratedDataModule(): string {
  const { manifest, bodies, catalogs } = buildManifest();
  return `${HEADER}
import type { CatalogDefinition, SkillsManifest } from './types.js';

export const SKILLS_MANIFEST: SkillsManifest = ${JSON.stringify(manifest, null, 2)};

export const SKILL_BODIES: Record<string, string> = ${JSON.stringify(bodies, null, 2)};

export const CATALOG_DATA: Record<string, CatalogDefinition> = ${JSON.stringify(catalogs, null, 2)};
`;
}

async function main(): Promise<void> {
  const rendered = renderGeneratedDataModule();
  writeFileSync(OUTPUT_PATH, rendered);
  process.stdout.write(`wrote ${OUTPUT_PATH}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
