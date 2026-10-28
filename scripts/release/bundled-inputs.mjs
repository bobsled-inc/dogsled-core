import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

export function filesUnder(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : entry.isFile() ? [file] : [];
  });
}

export function collectBundledInputs(root, metafiles, supplements) {
  const store = realpathSync(path.join(root, 'node_modules/.pnpm'));
  const slots = readdirSync(store);
  const packages = new Map();
  const add = (name, version, slot, input) => {
    const id = `${name}@${version}`;
    if (!packages.has(id)) {
      const prefix = `${name.replace('/', '+')}@${version}`;
      const available = [slot, ...slots.filter((s) => s === prefix || s.startsWith(`${prefix}_`))]
        .filter(Boolean)
        .map((s) => path.join(store, s, 'node_modules', name))
        .find((d) => existsSync(path.join(d, 'package.json')));
      if (!available) {
        if (!supplements[id]?.packageDocuments?.length || !supplements[id]?.license)
          throw new Error(`Unresolved vendored package: ${id}`);
        packages.set(id, {
          manifest: { name, version, license: supplements[id].license },
          inputs: new Set(),
        });
      } else {
        const manifest = JSON.parse(readFileSync(path.join(available, 'package.json'), 'utf8'));
        if (manifest.name !== name || manifest.version !== version)
          throw new Error(`Invalid package identity: ${id}`);
        packages.set(id, { directory: available, manifest, inputs: new Set() });
      }
    }
    const pkg = packages.get(id);
    if (input && pkg.directory) {
      const file = path.resolve(pkg.directory, input);
      if (path.relative(pkg.directory, file).startsWith('..'))
        throw new Error('Bundled input escapes its package.');
      if (existsSync(file)) pkg.inputs.add(file);
    }
    return pkg;
  };
  for (const descriptor of metafiles) {
    const metadata = JSON.parse(readFileSync(path.join(root, descriptor.file), 'utf8'));
    if (!metadata.inputs || !Object.keys(metadata.inputs).length)
      throw new Error(`Missing metafile inputs: ${descriptor.file}`);
    for (const input of Object.keys(metadata.inputs)) {
      if (!input.split(path.sep).includes('node_modules')) continue;
      const source = realpathSync(path.resolve(root, descriptor.cwd, input));
      const relative = path.relative(store, source);
      if (relative.startsWith('..') || path.isAbsolute(relative))
        throw new Error(`Bundled dependency is outside the pnpm store: ${input}`);
      const segments = relative.split(path.sep);
      if (segments[1] !== 'node_modules') throw new Error(`Unrecognized pnpm input: ${input}`);
      const scoped = segments[2].startsWith('@');
      const name = segments.slice(2, scoped ? 4 : 3).join('/');
      const directory = path.join(store, segments[0], 'node_modules', name);
      const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
      add(name, manifest.version, segments[0], segments.slice(scoped ? 4 : 3).join('/'));
    }
  }
  for (const pkg of packages.values()) {
    if (!pkg.directory) continue;
    const maps = new Set([
      ...filesUnder(path.join(pkg.directory, 'dist')).filter((f) => f.endsWith('.map')),
      ...[...pkg.inputs].flatMap((f) =>
        f.endsWith('.map') ? [f] : existsSync(`${f}.map`) ? [`${f}.map`] : []
      ),
    ]);
    for (const file of maps) {
      pkg.inputs.add(file);
      const metadata = JSON.parse(readFileSync(file, 'utf8'));
      for (const source of metadata.sources ?? []) {
        const pattern =
          /(?:^|\/)node_modules\/\.pnpm\/([^/]+)\/node_modules\/(@[^/]+\/[^/]+|[^/]+)(?:\/|$)/g;
        for (const match of source.replaceAll('\\', '/').matchAll(pattern)) {
          const [, slot, name] = match;
          const prefix = `${name.replace('/', '+')}@`;
          if (!slot.startsWith(prefix)) throw new Error('Unrecognized vendored package identity.');
          const version = slot.slice(prefix.length).split('_')[0];
          add(name, version, slot, source.slice(match.index + match[0].length));
        }
      }
    }
  }
  return [...packages.values()];
}
