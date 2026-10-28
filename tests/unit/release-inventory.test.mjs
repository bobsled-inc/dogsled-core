import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { normalizeStagedManifest } from '../../scripts/release/stage-package.mjs';
import { mergeBundledComponents, completeBundledSbom } from '../../scripts/release/sbom.mjs';
import { collectBundledPackages } from '../../scripts/release/third-party-notices.mjs';

const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

describe('published inventory', () => {
  it('strips development scripts and notes from staged manifests', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'stage-manifest-'));
    try {
      const file = path.join(directory, 'package.json');
      writeFileSync(
        file,
        JSON.stringify({
          name: 'example',
          version: '1.0.0',
          scripts: { bundle: 'bash scripts/pack.sh' },
          _dependencyNote: 'dev',
          pnpm: {},
          devDependencies: {},
        })
      );
      expect(normalizeStagedManifest(file, {}, new Map(), {})).toEqual({
        name: 'example',
        version: '1.0.0',
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('merges known inlined packages from bundler metadata and records the SBOM hash', () => {
    const packages = collectBundledPackages();
    expect(packages.some((pkg) => pkg.name === 'commander')).toBe(true);
    const sbom = {
      bomFormat: 'CycloneDX',
      components: [],
      metadata: { component: { 'bom-ref': 'dogsled' } },
    };
    mergeBundledComponents(sbom, packages);
    expect(sbom.components).toHaveLength(packages.length);
    expect(sbom.components.find((component) => component.name === 'commander')).toMatchObject({
      type: 'library',
      purl: expect.stringMatching(/^pkg:npm\/commander@/),
      properties: [{ name: 'dogsled:inlined', value: 'true' }],
      licenses: expect.any(Array),
    });
    mergeBundledComponents(sbom, packages);
    expect(sbom.components).toHaveLength(packages.length);
    expect(sbom.dependencies[0].dependsOn).toHaveLength(packages.length);
    const directory = mkdtempSync(path.join(os.tmpdir(), 'bundled-sbom-'));
    try {
      const file = path.join(directory, 'sbom.json');
      writeFileSync(file, JSON.stringify(sbom));
      expect(completeBundledSbom(file, packages)).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    expect(() => mergeBundledComponents({}, packages)).toThrow('CycloneDX');
    expect(() => mergeBundledComponents(sbom, [])).toThrow('Missing');
  });

  it('carries the Apache Ossie notice and points to the bundled notices', () => {
    for (const file of ['NOTICE', 'packages/dogsled/NOTICE']) {
      expect(read(file)).toContain('Apache Ossie (incubating)');
      expect(read(file)).toContain('Copyright 2026 The Apache Software Foundation');
      expect(read(file)).toContain('THIRD_PARTY_NOTICES.md');
    }
    expect(read('packages/dogsled/scripts/pack.sh')).not.toContain('app/public');
  });
});

describe('reviewed dependency exceptions', () => {
  it('removes exceptions for patched runtime dependencies', () => {
    const audit = JSON.parse(read('audit-ci.json')).allowlist.flatMap((entry) =>
      Object.entries(entry)
    );
    const consumer = JSON.parse(read('scripts/security/consumer-exceptions.json'));
    expect(audit.some(([key]) => key.includes('follow-redirects'))).toBe(false);
    expect(consumer.some((entry) => entry.package === 'follow-redirects')).toBe(false);
    expect(audit.some(([key]) => key.endsWith('>@modelcontextprotocol/sdk'))).toBe(false);
    expect(consumer.some((entry) => entry.package === '@modelcontextprotocol/sdk')).toBe(false);
    for (const name of ['undici', 'zod', 'toml', 'dompurify', 'next', 'body-parser']) {
      expect(audit.some(([key]) => key.endsWith(`>${name}`))).toBe(false);
      expect(consumer.some((entry) => entry.package === name)).toBe(false);
    }
  });
});
