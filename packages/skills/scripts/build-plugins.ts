/** Generate installable agent plugins from the same sources as the CLI bundle. */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { stringify } from 'yaml';

import { buildManifest, parseSkill, resolveTransclusions } from './build-manifest.js';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PLUGIN_PATH = 'plugins/bobsled-core';
// Bump this when publishing a changed plugin bundle; CLI releases are separate.
const PLUGIN_VERSION = '0.1.0';
const DESCRIPTION =
  'Set up local Dogsled Core projects, build data pipelines and models, and diagnose failures.';

/** These paths are generated, committed, and installed without a build step. */
export function renderPluginFiles(): Record<string, string> {
  const { manifest } = buildManifest();
  const files: Record<string, string> = {};
  const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
  const identity = {
    name: 'bobsled-core',
    version: PLUGIN_VERSION,
    description: DESCRIPTION,
    author: { name: 'Dogsled maintainers' },
    homepage: 'https://github.com/bobsled-inc/dogsled-core',
    repository: 'https://github.com/bobsled-inc/dogsled-core',
    license: 'Apache-2.0',
  };
  files[`${PLUGIN_PATH}/.claude-plugin/plugin.json`] = json(identity);
  files[`${PLUGIN_PATH}/plugin.json`] = json({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    ...identity,
    extensions: {
      'com.openai': {
        interface: {
          displayName: 'Dogsled Core',
          shortDescription: 'Build local data pipelines and models with Dogsled Core',
          developerName: 'Dogsled maintainers',
          category: 'Developer Tools',
        },
      },
    },
  });
  files['.claude-plugin/marketplace.json'] = json({
    name: 'dogsled',
    description: DESCRIPTION,
    owner: { name: 'Dogsled maintainers' },
    plugins: [{ name: 'bobsled-core', source: `./${PLUGIN_PATH}`, description: DESCRIPTION }],
  });
  files['.agents/plugins/marketplace.json'] = json({
    name: 'dogsled',
    interface: { displayName: 'Dogsled' },
    plugins: [
      {
        name: 'bobsled-core',
        source: { source: 'local', path: `./${PLUGIN_PATH}` },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Developer Tools',
      },
    ],
  });
  for (const skill of manifest.skills) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name)) {
      throw new Error(`Invalid plugin skill name: ${skill.name}`);
    }
    const target = `${PLUGIN_PATH}/skills/${skill.name}`;
    const source = join(REPO_ROOT, '.agents/skills', skill.name);
    const renderDocument = (content: string, documentPath: string): string => {
      const rewriteLinks = (text: string, origin: string): string =>
        text.replace(/(\]\()([^\s)]+)(\))/g, (match, start: string, href: string, end: string) => {
          if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(href)) return match;
          const [file, anchor] = href.split('#');
          const absolute = resolve(dirname(origin), file!);
          const repoPath = relative(REPO_ROOT, absolute);
          if (repoPath.startsWith('..')) {
            throw new Error(`Plugin document link escapes repository: ${href}`);
          }
          const skillPath = relative(source, absolute);
          const destination = skillPath.startsWith('..')
            ? `https://github.com/bobsled-inc/dogsled-core/blob/main/${repoPath.split(sep).join('/')}`
            : relative(dirname(documentPath), absolute).split(sep).join('/');
          return `${start}${destination}${anchor ? `#${anchor}` : ''}${end}`;
        });
      return resolveTransclusions(rewriteLinks(content, documentPath), REPO_ROOT, rewriteLinks);
    };
    const skillFile = join(source, 'SKILL.md');
    const { body } = parseSkill(readFileSync(skillFile, 'utf8'), skillFile);
    files[`${target}/SKILL.md`] =
      `---\n${stringify({ name: skill.name, description: skill.description })}---\n\n${renderDocument(body, skillFile).trimEnd()}\n`;
    // Include skill-local references as well as the expanded main document.
    const copyReferences = (source: string, destination: string): void => {
      for (const entry of readdirSync(source, { withFileTypes: true })) {
        const sourcePath = join(source, entry.name);
        const targetPath = `${destination}/${entry.name}`;
        if (entry.isDirectory()) copyReferences(sourcePath, targetPath);
        else if (entry.isFile() && entry.name.endsWith('.md')) {
          files[targetPath] = renderDocument(readFileSync(sourcePath, 'utf8'), sourcePath);
        } else {
          throw new Error(`Unsupported plugin support file: ${sourcePath}`);
        }
      }
    };
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (entry.name === 'SKILL.md') continue;
      if (entry.isDirectory()) copyReferences(join(source, entry.name), `${target}/${entry.name}`);
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        files[`${target}/${entry.name}`] = renderDocument(
          readFileSync(join(source, entry.name), 'utf8'),
          join(source, entry.name)
        );
      } else throw new Error(`Unsupported plugin support file: ${skill.name}/${entry.name}`);
    }
  }
  for (const name of ['LICENSE', 'NOTICE']) {
    files[`${PLUGIN_PATH}/${name}`] = readFileSync(join(REPO_ROOT, name), 'utf8');
  }
  return files;
}

export function writePluginFiles(): void {
  const files = renderPluginFiles();
  // Remove only the generated skill tree, so removed support files cannot linger.
  rmSync(join(REPO_ROOT, PLUGIN_PATH, 'skills'), { recursive: true, force: true });
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(REPO_ROOT, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writePluginFiles();
}
