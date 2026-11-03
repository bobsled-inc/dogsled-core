import { mkdtempSync, readFileSync, readdirSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { buildManifest } from '../scripts/build-manifest.js';
import { renderPluginFiles, REPO_ROOT } from '../scripts/build-plugins.js';

const generated = renderPluginFiles();

describe('installable Dogsled plugin', () => {
  it('ships the current generated files without needing a build after installation', () => {
    for (const [path, content] of Object.entries(generated)) {
      expect(readFileSync(join(REPO_ROOT, path), 'utf8'), path).toBe(content);
    }
    const actual = readdirSync(join(REPO_ROOT, 'plugins/dogsled-core/skills'), { recursive: true })
      .map(String)
      .filter((path) => path.endsWith('.md'))
      .sort();
    const expected = Object.keys(generated)
      .filter((path) => path.startsWith('plugins/dogsled-core/skills/'))
      .map((path) => path.slice('plugins/dogsled-core/skills/'.length))
      .sort();
    expect(actual).toEqual(expected);
  });

  it('loads both catalogs and every exposed skill from an isolated plugin copy', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'dogsled-plugin-'));
    try {
      const plugin = join(temporary, 'dogsled-core');
      cpSync(join(REPO_ROOT, 'plugins/dogsled-core'), plugin, { recursive: true });
      const claudeCatalog = JSON.parse(generated['.claude-plugin/marketplace.json']!);
      const codexCatalog = JSON.parse(generated['.agents/plugins/marketplace.json']!);
      expect(claudeCatalog.plugins[0].source).toBe(codexCatalog.plugins[0].source.path);
      const claude = JSON.parse(readFileSync(join(plugin, '.claude-plugin/plugin.json'), 'utf8'));
      const codex = JSON.parse(readFileSync(join(plugin, 'plugin.json'), 'utf8'));
      expect(claudeCatalog.name).toBe('dogsled');
      expect(codexCatalog.name).toBe('dogsled');
      expect(claudeCatalog.plugins[0].name).toBe('dogsled-core');
      expect(codexCatalog.plugins[0].name).toBe('dogsled-core');
      expect(claude.name).toBe('dogsled-core');
      expect(codex.name).toBe(claude.name);
      expect(claude.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(codex.version).toBe(claude.version);
      expect(readdirSync(join(plugin, 'skills')).sort()).toEqual(
        buildManifest()
          .manifest.skills.map((skill) => skill.name)
          .sort()
      );
      expect(readFileSync(join(plugin, 'skills/dogsled-get-started/SKILL.md'), 'utf8')).toContain(
        'https://github.com/bobsled-inc/dogsled-core/blob/main/packages/dogsled/examples/tv-night/DESIGN.md'
      );
      for (const skill of buildManifest().manifest.skills) {
        const content = readFileSync(join(plugin, 'skills', skill.name, 'SKILL.md'), 'utf8');
        const metadata = parse(content.split('---\n')[1]!);
        expect(metadata.name).toBe(skill.name);
        expect(metadata.description).toBeTruthy();
        expect(content).not.toMatch(/\{\{include(?:-section)?:/);
        for (const match of content.matchAll(
          /https:\/\/github\.com\/bobsled-inc\/dogsled-core\/blob\/main\/([^\s)#]+)/g
        )) {
          expect(readFileSync(join(REPO_ROOT, match[1]!), 'utf8').length).toBeGreaterThan(0);
        }
        for (const match of content.matchAll(/\]\((?!https?:|#)([^)#]+)(?:#[^)]*)?\)/g)) {
          expect(readFileSync(join(plugin, 'skills', skill.name, match[1]!), 'utf8')).not.toMatch(
            /\{\{include(?:-section)?:/
          );
        }
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
