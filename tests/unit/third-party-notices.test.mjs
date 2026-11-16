import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  NOTICES_PATH,
  collectBundledPackages,
  renderThirdPartyNotices,
  checkThirdPartyNotices,
  checkPackedThirdPartyNotices,
} from '../../scripts/release/third-party-notices.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notice-fixture-'));
  roots.push(root);
  mkdirSync(path.join(root, 'node_modules/.pnpm'), { recursive: true });
  mkdirSync(path.join(root, 'packages/bobsled-core'), { recursive: true });
  const metafiles = [{ file: 'meta.json', cwd: '.' }];
  const inputs = {};
  function add(name, version, documents = { LICENSE: 'MIT license text' }, extra = {}) {
    const dir = path.join(
      root,
      'node_modules/.pnpm',
      `${name.replace('/', '+')}@${version}`,
      'node_modules',
      name
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name, version, license: 'MIT', ...extra })
    );
    writeFileSync(path.join(dir, 'index.js'), 'export const example = 1;');
    for (const [file, text] of Object.entries(documents)) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), text);
    }
    inputs[path.relative(root, path.join(dir, 'index.js'))] = { bytes: 1 };
    writeFileSync(path.join(root, 'meta.json'), JSON.stringify({ inputs }));
    return dir;
  }
  function generate() {
    const text = renderThirdPartyNotices(
      collectBundledPackages({ root, metafiles, embeddedNotices: {} })
    );
    writeFileSync(path.join(root, NOTICES_PATH), text);
    return text;
  }
  return { root, metafiles, embeddedNotices: {}, add, generate };
}

describe('bundled third-party notices', () => {
  it('resolves exact scoped packages and multiple versions, sorts deterministically, and carries NOTICE text', () => {
    const f = fixture();
    f.add('example', '2.0.0');
    f.add(
      '@example/scoped',
      '1.2.3',
      { 'LICENSE.txt': 'Apache license', NOTICE: 'Required upstream attribution' },
      { license: 'Apache-2.0' }
    );
    f.add('example', '1.0.0');
    const inventory = collectBundledPackages(f);
    expect(inventory.map((pkg) => pkg.id)).toEqual([
      '@example/scoped@1.2.3',
      'example@1.0.0',
      'example@2.0.0',
    ]);
    const text = f.generate();
    expect(text.split(String.fromCharCode(10)).length).toBeGreaterThan(10);
    expect(text).toContain('Required upstream attribution');
    expect(checkThirdPartyNotices(f)).toBe(text);
    expect(f.generate()).toBe(text);
  });

  it('fails closed when license text is missing or empty', () => {
    const f = fixture();
    const dir = f.add('example', '1.0.0', { NOTICE: 'Attribution alone is not a license' });
    expect(() => collectBundledPackages(f)).toThrow('No license text');
    writeFileSync(path.join(dir, 'LICENSE'), '');
    expect(() => collectBundledPackages(f)).toThrow('Empty license');
  });

  it('can recover full MIT text from the declaration plus a copyright statement', () => {
    const f = fixture();
    f.add('example', '1.0.0', {}, { copyright: 'Copyright Example Authors' });
    expect(f.generate()).toContain('Permission is hereby granted');
    expect(f.generate()).toContain('Copyright Example Authors');
  });

  it('accepts only an anchored year-bearing README copyright fallback', () => {
    const f = fixture();
    const dir = f.add('example', '1.0.0', { 'README.md': 'Unrelated copyright prose' });
    expect(() => collectBundledPackages(f)).toThrow('No license text');
    writeFileSync(
      path.join(dir, 'README.md'),
      'Introduction\nCopyright (c) 2024 Example Authors\n'
    );
    expect(f.generate()).toContain('Copyright (c) 2024 Example Authors');
  });

  it('rejects a changed declaration for a reviewed copyright fallback', () => {
    const f = fixture();
    f.add('@ai-sdk/provider-utils', '4.0.56', {}, { license: 'MIT' });
    expect(() => collectBundledPackages({ ...f, embeddedNotices: {} })).toThrow(
      'Fallback license declaration changed'
    );
  });

  it('fails on unreviewed per-file license markers and carries the reviewed supplement', () => {
    const f = fixture();
    const header =
      '// Licensed under BSD-3-Clause (this file only)\n// Copyright 2024 Example Authors';
    const dir = f.add('example', '1.0.0', { LICENSE: 'MIT text', 'src/vendor.js': header });
    expect(() => collectBundledPackages(f)).toThrow('Unreviewed per-file license marker');
    const embeddedNotices = {
      'example@1.0.0': {
        files: { 'src/vendor.js': createHash('sha256').update(header).digest('hex') },
        licenses: ['BSD-3-Clause'],
        notices: [{ name: 'Embedded BSD notice', text: header }],
      },
    };
    expect(renderThirdPartyNotices(collectBundledPackages({ ...f, embeddedNotices }))).toContain(
      header
    );
    writeFileSync(path.join(dir, 'src/vendor.js'), header + '\n// SPDX-License-Identifier: MIT');
    expect(() => collectBundledPackages({ ...f, embeddedNotices })).toThrow(
      'Unreviewed per-file license marker'
    );
  });

  it('inventories transitive source-map packages and rejects unresolved versions', () => {
    const f = fixture();
    const parent = f.add('parent', '1.0.0');
    f.add('@example/vendored', '2.0.0', { LICENSE: 'Exact older MIT attribution' });
    const metadata = JSON.parse(readFileSync(path.join(f.root, 'meta.json'), 'utf8'));
    for (const key of Object.keys(metadata.inputs))
      if (key.includes('@example+vendored')) delete metadata.inputs[key];
    writeFileSync(path.join(f.root, 'meta.json'), JSON.stringify(metadata));
    mkdirSync(path.join(parent, 'dist'), { recursive: true });
    const map = path.join(parent, 'dist/index.js.map');
    writeFileSync(
      map,
      JSON.stringify({
        sources: [
          '../node_modules/.pnpm/@example+vendored@2.0.0/node_modules/@example/vendored/index.js',
        ],
      })
    );
    expect(collectBundledPackages(f).map((p) => p.id)).toEqual([
      '@example/vendored@2.0.0',
      'parent@1.0.0',
    ]);
    expect(f.generate()).toContain('Exact older MIT attribution');
    writeFileSync(
      map,
      JSON.stringify({
        sources: ['../node_modules/.pnpm/missing@3.0.0/node_modules/missing/index.js'],
      })
    );
    expect(() => collectBundledPackages(f)).toThrow('Unresolved vendored package: missing@3.0.0');
    const embeddedNotices = {
      'missing@3.0.0': {
        license: 'MIT',
        packageDocuments: [{ name: 'Reviewed LICENSE', text: 'Reviewed exact MIT text' }],
      },
    };
    expect(renderThirdPartyNotices(collectBundledPackages({ ...f, embeddedNotices }))).toContain(
      'Reviewed exact MIT text'
    );
    embeddedNotices['unused@1.0.0'] = { files: { 'removed.js': 'old' }, notices: [] };
    expect(() => collectBundledPackages({ ...f, embeddedNotices })).toThrow(
      'Stale reviewed package supplement'
    );
  });

  it('checks exact inputs outside src/dist and rejects stale reviewed marker paths', () => {
    const f = fixture();
    const header = '// SPDX-License-Identifier: MIT';
    const dir = f.add('example', '1.0.0', { LICENSE: 'MIT text', 'index.js': header });
    expect(() => collectBundledPackages(f)).toThrow('Unreviewed per-file license marker');
    const embeddedNotices = {
      'example@1.0.0': {
        files: { 'index.js': createHash('sha256').update(header).digest('hex') },
        notices: [{ name: 'Reviewed input header', text: header }],
      },
    };
    expect(collectBundledPackages({ ...f, embeddedNotices })).toHaveLength(1);
    writeFileSync(path.join(dir, 'index.js'), 'export const example = 1;');
    expect(() => collectBundledPackages({ ...f, embeddedNotices })).toThrow(
      'Stale reviewed per-file license'
    );
    embeddedNotices['example@1.0.0'].files['removed.js'] = 'unused';
    delete embeddedNotices['example@1.0.0'].files['index.js'];
    expect(() => collectBundledPackages({ ...f, embeddedNotices })).toThrow('removed.js');
  });

  it('carries nested vendored licence files without replacing the package fallback', () => {
    const f = fixture();
    f.add(
      'example',
      '1.0.0',
      { 'src/vendor/LICENSE': 'ISC vendored attribution' },
      { copyright: 'Copyright 2025 Example Authors' }
    );
    const notices = f.generate();
    expect(notices).toContain('ISC vendored attribution');
    expect(notices).toContain('Permission is hereby granted');
    expect(notices).toContain('Copyright 2025 Example Authors');
  });

  it('rejects missing or stale coverage after a new package is inlined', () => {
    const f = fixture();
    f.add('example', '1.0.0');
    expect(() => checkThirdPartyNotices(f)).toThrow('missing or stale');
    f.generate();
    f.add('another', '2.0.0');
    expect(() => checkThirdPartyNotices(f)).toThrow('missing or stale');
    expect(() =>
      renderThirdPartyNotices([{ id: 'example@1.0.0', documents: [{ text: '' }] }])
    ).toThrow('Missing license text');
  });

  it('rejects a missing tarball notice and verifies the exact packed license contents', () => {
    const f = fixture();
    f.add('example', '1.0.0');
    f.generate();
    expect(() => checkPackedThirdPartyNotices('unused', [], f)).toThrow(
      'missing THIRD_PARTY_NOTICES'
    );
    mkdirSync(path.join(f.root, 'package'));
    const packed = path.join(f.root, 'package/THIRD_PARTY_NOTICES.md');
    const tarball = path.join(f.root, 'package.tgz');
    writeFileSync(packed, readFileSync(path.join(f.root, NOTICES_PATH)));
    execFileSync('tar', ['-czf', tarball, '-C', f.root, 'package']);
    expect(() =>
      checkPackedThirdPartyNotices(tarball, ['package/THIRD_PARTY_NOTICES.md'], f)
    ).not.toThrow();
    writeFileSync(packed, 'missing license text');
    execFileSync('tar', ['-czf', tarball, '-C', f.root, 'package']);
    expect(() =>
      checkPackedThirdPartyNotices(tarball, ['package/THIRD_PARTY_NOTICES.md'], f)
    ).toThrow('differ');
  });
});
