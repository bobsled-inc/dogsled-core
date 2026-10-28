import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectBundledInputs, filesUnder } from './bundled-inputs.mjs';

const releaseDirectory = path.dirname(fileURLToPath(import.meta.url));
const EMBEDDED_NOTICES = JSON.parse(
  readFileSync(path.join(releaseDirectory, 'embedded-notices.json'), 'utf8')
);
const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const NOTICES_PATH = 'packages/dogsled/THIRD_PARTY_NOTICES.md';
const COPYRIGHT_FALLBACKS = {
  '@ai-sdk/provider-utils@4.0.56': {
    license: 'Apache-2.0',
    copyright: 'Copyright 2023 Vercel, Inc.',
    source: 'https://github.com/vercel/ai/blob/fc81a9e75f7d48fc2c02b6c77fd6c204664624bc/LICENSE',
  },
};
const METAFILES = [
  { file: 'packages/ai/dist/metafile-esm.json', cwd: 'packages/ai' },
  { file: 'packages/dogsled/dist/metafile-esm.json', cwd: 'packages/dogsled' },
];
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const readText = (file) => readFileSync(file, 'utf8').replaceAll('\r\n', '\n').trim();
const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

function licenseDocuments(directory, manifest, root) {
  const documentPaths = [
    ...readdirSync(directory, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => path.join(directory, e.name)),
    ...filesUnder(path.join(directory, 'src')),
    ...filesUnder(path.join(directory, 'dist')),
  ].filter((file) =>
    /^(?:licen[cs]e|notice|copyright)(?:$|[._-]|notice)/i.test(path.basename(file))
  );
  const files = [...new Set(documentPaths)]
    .map((file) => ({
      name: path.relative(directory, file).split(path.sep).join('/'),
      text: readText(file),
    }))
    .sort((a, b) => compare(a.name, b.name));
  const licenseFiles = files.filter((file) => /^licen[cs]e/i.test(file.name));
  if (licenseFiles.some((file) => !file.text) || files.some((file) => !file.text)) {
    throw new Error(`Empty license or notice text for ${manifest.name}@${manifest.version}.`);
  }
  if (licenseFiles.length === 0) {
    const readme = readdirSync(directory).find((name) => /^readme(?:\.|$)/i.test(name));
    const fallback = COPYRIGHT_FALLBACKS[`${manifest.name}@${manifest.version}`];
    const copyright =
      manifest.copyright ??
      fallback?.copyright ??
      (readme &&
        readText(path.join(directory, readme)).match(/^Copyright (?:\(c\) )?\d{4}[^\n]*/im)?.[0]);
    const license =
      typeof manifest.license === 'string' ? manifest.license : manifest.license?.type;
    if (fallback && fallback.license !== license)
      throw new Error('Fallback license declaration changed.');
    const text =
      license === 'MIT'
        ? MIT_TEXT
        : license === 'Apache-2.0'
          ? readText(path.join(releaseDirectory, 'licenses/Apache-2.0.txt'))
          : undefined;
    if (typeof copyright !== 'string' || !copyright.trim() || !text) {
      throw new Error(
        `No license text for ${manifest.name}@${manifest.version}; supply LICENSE text or a supported license declaration and copyright.`
      );
    }
    files.unshift({
      name: 'License declaration and copyright',
      text: `${fallback ? `Source: ${fallback.source}\n\n` : ''}${copyright.trim()}\n\n${text}`,
    });
  }
  return files;
}

function embeddedLicenseDocuments(directory, manifest, supplements, inputs) {
  const id = `${manifest.name}@${manifest.version}`;
  const supplement = supplements[id];
  const visited = new Set();
  const files = new Set([
    ...filesUnder(path.join(directory, 'src')),
    ...filesUnder(path.join(directory, 'dist')),
    ...inputs,
  ]);
  for (const file of files) {
    const bytes = readFileSync(file);
    if (
      !/Licensed under|License for this File only|SPDX-License-Identifier/i.test(
        bytes.toString('utf8')
      )
    )
      continue;
    const relative = path.relative(directory, file).split(path.sep).join('/');
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (
      supplement?.files?.[relative] !== digest ||
      !supplement.notices?.length ||
      supplement.notices.some((notice) => !notice.text?.trim())
    )
      throw new Error(`Unreviewed per-file license marker: ${id}/${relative}`);
    visited.add(relative);
  }
  for (const file of Object.keys(supplement?.files ?? {}))
    if (!visited.has(file)) throw new Error(`Stale reviewed per-file license: ${id}/${file}`);
  return { documents: supplement?.notices ?? [], licenses: supplement?.licenses ?? [] };
}

export function collectBundledPackages({
  root = defaultRoot,
  metafiles = METAFILES,
  embeddedNotices = EMBEDDED_NOTICES,
} = {}) {
  const packages = collectBundledInputs(root, metafiles, embeddedNotices).map(
    ({ directory, manifest, inputs }) => {
      const id = `${manifest.name}@${manifest.version}`;
      const supplement = embeddedNotices[id];
      const embedded = directory
        ? embeddedLicenseDocuments(directory, manifest, embeddedNotices, inputs)
        : { documents: supplement.notices ?? [], licenses: supplement.licenses ?? [] };
      const documents = directory
        ? licenseDocuments(directory, manifest, root)
        : supplement.packageDocuments;
      if (!documents.length || documents.some((d) => !d.text?.trim()))
        throw new Error(`Missing license text for ${id}`);
      return {
        id,
        name: manifest.name,
        version: manifest.version,
        license:
          typeof manifest.license === 'string'
            ? manifest.license
            : (manifest.license?.type ?? 'See license text'),
        embeddedLicenses: embedded.licenses,
        documents: [...documents, ...embedded.documents],
      };
    }
  );
  if (!packages.length) throw new Error('Metafiles contain no bundled third-party packages.');
  for (const id of Object.keys(embeddedNotices))
    if (!packages.some((pkg) => pkg.id === id))
      throw new Error(`Stale reviewed package supplement: ${id}`);
  return packages.sort((a, b) => compare(a.id, b.id));
}

export function renderThirdPartyNotices(packages) {
  return (
    '# Third-party notices\n\nGenerated from the bundled AI and CLI metafile inputs and upstream source maps. Regenerate with\n`node scripts/release/third-party-notices.mjs` after building.\n\n' +
    packages
      .map((pkg) => {
        if (!pkg.documents.length || pkg.documents.some((doc) => !doc.text.trim()))
          throw new Error(`Missing license text for ${pkg.id}`);
        return (
          `## ${pkg.id}\n\nDeclared license: ${pkg.license}\n${pkg.embeddedLicenses?.length ? `Embedded file licenses: ${pkg.embeddedLicenses.join(', ')}\n` : ''}\n` +
          pkg.documents
            .map((doc) => {
              const fence = String.fromCharCode(96).repeat(
                Math.max(3, ...[...doc.text.matchAll(/`+/g)].map((match) => match[0].length + 1))
              );
              return `### ${doc.name}\n\n${fence}text\n${doc.text}\n${fence}\n`;
            })
            .join('\n')
        );
      })
      .join('\n')
  );
}

export function checkThirdPartyNotices(options = {}) {
  const root = options.root ?? defaultRoot;
  const expected = renderThirdPartyNotices(collectBundledPackages(options));
  if (
    !existsSync(path.join(root, NOTICES_PATH)) ||
    readFileSync(path.join(root, NOTICES_PATH), 'utf8') !== expected
  ) {
    throw new Error(
      'Third-party notices are missing or stale; build and regenerate them before packing.'
    );
  }
  return expected;
}

export function checkPackedThirdPartyNotices(tarball, entries, options = {}) {
  const entry = 'package/THIRD_PARTY_NOTICES.md';
  if (!entries.includes(entry)) throw new Error('Tarball is missing THIRD_PARTY_NOTICES.md.');
  const packed = execFileSync('tar', ['-xOf', tarball, entry], { encoding: 'utf8' });
  if (packed !== checkThirdPartyNotices(options))
    throw new Error('Packed third-party notices differ from the reviewed inventory.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.includes('--check')) checkThirdPartyNotices();
    else {
      const packages = collectBundledPackages();
      writeFileSync(path.join(defaultRoot, NOTICES_PATH), renderThirdPartyNotices(packages));
      process.stdout.write(`Wrote notices for ${packages.length} bundled package versions.\n`);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
