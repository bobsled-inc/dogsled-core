import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeRuntimeNotices } from './notices.mjs';

const kitRoot = dirname(fileURLToPath(import.meta.url));
const demoRoot = kitRoot;
if (!process.env.DOGSLED_UI_ROOT)
  throw new Error('Set DOGSLED_UI_ROOT to a prepared UI workspace.');
const uiRepository = resolve(process.env.DOGSLED_UI_ROOT);
const uiPackage = join(uiRepository, 'packages/ui');
const uiRequire = createRequire(join(uiPackage, 'package.json'));
const require = createRequire(import.meta.url);
const viteRequire = createRequire(uiRequire.resolve('vite'));
const { build } = viteRequire('esbuild');
const tailwindRequire = createRequire(uiRequire.resolve('@tailwindcss/vite'));
const { compile, optimize } = tailwindRequire('@tailwindcss/node');
const { Scanner } = tailwindRequire('@tailwindcss/oxide');
const output = join(kitRoot, '.build/assets');
const temporary = join(kitRoot, '.build');
await mkdir(output, { recursive: true });
await mkdir(temporary, { recursive: true });
await mkdir(join(kitRoot, 'LICENSES'), { recursive: true });
for (const [name, file] of [
  ['inter', 'Inter-OFL.txt'],
  ['roboto-mono', 'Roboto-Mono-OFL.txt'],
]) {
  const fontRoot = dirname(uiRequire.resolve(`@fontsource-variable/${name}/package.json`));
  await writeFile(join(kitRoot, 'LICENSES', file), await readFile(join(fontRoot, 'LICENSE')));
}
const packageInfo = JSON.parse(await readFile(join(uiPackage, 'package.json'), 'utf8'));
await mkdir(join(kitRoot, 'node_modules/@dogsled'), { recursive: true });
await mkdir(join(kitRoot, 'node_modules/@types'), { recursive: true });
for (const [target, link] of [
  [uiPackage, join(kitRoot, 'node_modules/@dogsled/ui')],
  [join(uiPackage, 'node_modules/react'), join(kitRoot, 'node_modules/react')],
  [join(uiPackage, 'node_modules/react-dom'), join(kitRoot, 'node_modules/react-dom')],
  [join(uiPackage, 'node_modules/@types/react'), join(kitRoot, 'node_modules/@types/react')],
  [
    join(uiPackage, 'node_modules/@types/react-dom'),
    join(kitRoot, 'node_modules/@types/react-dom'),
  ],
]) {
  try {
    await access(link);
  } catch {
    await symlink(target, link);
  }
}
const brandAssets = new Map();
const embedBrandAssets = {
  name: 'embed-canonical-brand-assets',
  setup(builder) {
    builder.onLoad({ filter: /\/assets\/brand\/dogsled\.ts$/ }, async ({ path }) => {
      let contents = await readFile(path, 'utf8');
      const urls = [
        ...contents.matchAll(
          /new URL\(\s*["']([^"']+\.svg)["']\s*,\s*import\.meta\.url\s*\)\s*\.href/g
        ),
      ];
      if (!urls.length)
        throw new Error('The canonical brand asset module changed; update its bundling adapter.');
      for (const match of urls) {
        const assetPath = resolve(dirname(path), match[1]);
        const asset = await readFile(assetPath);
        contents = contents.replace(
          match[0],
          JSON.stringify(`data:image/svg+xml;base64,${asset.toString('base64')}`)
        );
        brandAssets.set(relative(uiPackage, assetPath), {
          path: relative(uiPackage, assetPath),
          bytes: asset.length,
          sha256: createHash('sha256').update(asset).digest('hex'),
        });
      }
      return { contents, loader: 'ts', resolveDir: dirname(path) };
    });
  },
};
const shared = {
  absWorkingDir: kitRoot,
  bundle: true,
  jsx: 'automatic',
  conditions: ['development'],
  define: { 'process.env.NODE_ENV': '"production"' },
  alias: {
    react: join(uiPackage, 'node_modules/react'),
    'react-dom': join(uiPackage, 'node_modules/react-dom'),
  },
  plugins: [embedBrandAssets],
  legalComments: 'inline',
  logLevel: 'info',
};
const clientBuild = await build({
  ...shared,
  entryPoints: [join(kitRoot, 'src/client.tsx')],
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  minify: true,
  metafile: true,
  outfile: join(output, 'runtime.js'),
});
await writeFile(join(temporary, 'client-meta.json'), JSON.stringify(clientBuild.metafile));
await build({
  ...shared,
  entryPoints: [join(kitRoot, 'src/server.tsx')],
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: join(temporary, 'server.cjs'),
});
const metadata = clientBuild.metafile;
const bundledPackages = await writeRuntimeNotices(
  metadata,
  kitRoot,
  join(kitRoot, 'LICENSES/runtime.txt')
);
const inputs = Object.keys(metadata.inputs).map((path) => resolve(kitRoot, path));
const scanner = new Scanner({ sources: [] });
const candidates = scanner.scanFiles(
  await Promise.all(
    inputs.map(async (path) => ({
      content: await readFile(path, 'utf8'),
      extension: extname(path).slice(1),
    }))
  )
);
const fontFace = async (family, module) => {
  const encoded = (await readFile(uiRequire.resolve(module))).toString('base64');
  return `@font-face{font-family:"${family}";font-style:normal;font-weight:100 900;font-display:swap;src:url(data:font/woff2;base64,${encoded}) format("woff2");}`;
};
const fonts = [
  await fontFace(
    'Inter Variable',
    '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2'
  ),
  await fontFace(
    'Roboto Mono Variable',
    '@fontsource-variable/roboto-mono/files/roboto-mono-latin-wght-normal.woff2'
  ),
].join('\n');
const cssInput = `@import "${join(uiPackage, 'src/styles/theme.css')}";\n${fonts}\n${await readFile(join(kitRoot, 'src/layout.css'), 'utf8')}`;
const compiler = await compile(cssInput, { base: uiPackage, onDependency() {} });
const css = optimize(compiler.build(candidates), { minify: true }).code;
await writeFile(join(output, 'theme.css'), css);
const snapshotFile = resolve(process.argv[2] ?? join(demoRoot, 'fixtures/snapshot.json'));
const snapshot = JSON.parse(await readFile(snapshotFile, 'utf8'));
if (!Array.isArray(snapshot.state?.steps) || !Array.isArray(snapshot.tables))
  throw new Error('Expected a saved tutorial snapshot.');
const { renderArtifact } = require(join(temporary, 'server.cjs'));
const markup = renderArtifact(snapshot);
const runtime = (await readFile(join(output, 'runtime.js'), 'utf8')).replace(
  /<\/script/gi,
  '<\\/script'
);
const safeJson = JSON.stringify(snapshot)
  .replace(/</g, '\\u003c')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');
const html = `<!doctype html><!-- @generated by build.mjs; edit src/ instead. --><html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>TV Night · Dogsled design preview</title><style>${css}</style></head><body><div id="tutorial-root">${markup}</div><script id="tutorial-snapshot" type="application/json">${safeJson}</script><script>${runtime}</script></body></html>`;
const htmlPath = join(demoRoot, 'index.html');
await writeFile(htmlPath, html);
const source = (
  await Promise.all(
    (await readdir(join(kitRoot, 'src')))
      .filter((name) => /\.tsx?$/.test(name))
      .map((name) => readFile(join(kitRoot, 'src', name), 'utf8'))
  )
).join('\n');
const imports = [
  ...new Set([...source.matchAll(/from ['"](@dogsled\/ui\/[^'"]+)['"]/g)].map((match) => match[1])),
].sort();
let previousLayoutBytes;
try {
  previousLayoutBytes = (await readFile(join(demoRoot, 'comparisons/workspace.html'))).length;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const manifest = {
  name: 'dogsled-tutorial-artifact-prototype',
  version: '0.7.1',
  distribution: 'local-prototype',
  generatedAt: new Date().toISOString(),
  sourcePackage: packageInfo.name,
  sourcePackagePrivate: packageInfo.private,
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: uiRepository,
    encoding: 'utf8',
  }).trim(),
  snapshotContract: 'Dogsled onboarding saved snapshot',
  imports,
  assets: {
    css: {
      file: 'theme.css',
      bytes: Buffer.byteLength(css),
      sha256: createHash('sha256').update(css).digest('hex'),
    },
    javascript: {
      file: 'runtime.js',
      bytes: Buffer.byteLength(runtime),
      sha256: createHash('sha256').update(runtime).digest('hex'),
    },
  },
  htmlBytes: Buffer.byteLength(html),
  externalRuntimeResources: 0,
  graphPresentation:
    'GraphNode components with rounded elbow SVG connectors and open arrowheads; no canvas engine',
  previousLayoutBytes,
  brandAssets: [...brandAssets.values()],
  bundledPackages,
  licenseFiles: [
    'LICENSES/Inter-OFL.txt',
    'LICENSES/Roboto-Mono-OFL.txt',
    'LICENSES/runtime.txt',
    'LICENSES/react-remove-scroll-bar.txt',
  ],
  sourceFingerprints: await Promise.all(
    inputs
      .filter((path) => path.startsWith(join(uiPackage, 'src')))
      .map(async (path) => ({
        path: relative(uiPackage, path),
        sha256: createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      }))
  ),
};
await writeFile(join(kitRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const paths = Object.fromEntries(
  imports.map((name) => {
    const key = `./${name.slice('@dogsled/ui/'.length)}`;
    const entry = packageInfo.exports[key] ?? packageInfo.exports['./icons/*'];
    const exportedPath = entry.development.replace('*', name.split('/').at(-1));
    return [name, [resolve(uiPackage, exportedPath)]];
  })
);
await writeFile(
  join(kitRoot, 'tsconfig.json'),
  `${JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', jsx: 'react-jsx', strict: true, skipLibCheck: true, noEmit: true, esModuleInterop: true, lib: ['ES2022', 'DOM', 'DOM.Iterable'], paths }, include: ['src/**/*.ts', 'src/**/*.tsx'] }, null, 2)}\n`
);
process.stdout.write(
  `${JSON.stringify({ path: htmlPath, htmlBytes: manifest.htmlBytes, cssBytes: manifest.assets.css.bytes, javascriptBytes: manifest.assets.javascript.bytes, exportsUsed: imports.length, externalRuntimeResources: 0 }, null, 2)}\n`
);
