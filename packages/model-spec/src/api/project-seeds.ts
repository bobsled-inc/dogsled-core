import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
  readFileSync,
  type Dirent,
} from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import {
  assertValidProjectIndex,
  entriesOfKind,
  resolveProjectIndex,
  type ProjectIndex,
  type ProjectIndexEntry,
} from '@bobsled-inc/project-index';
import { formatSpecValidationMessage } from '@bobsled-inc/protocol';
import { LineCounter, parse as parseYaml, YAMLError } from 'yaml';

import { readCsv } from '../compiler/seed/csv-reader.js';
import { SeedSpecSchema } from '../compiler/schemas.js';
import { CommandError } from '../errors.js';

import type { ParsedSeedSpec } from '../compiler/seed/parser.js';

export interface DiscoveredBareSeedCsv {
  readonly path: string;
  readonly headers?: readonly string[];
  readonly rowCount?: number;
  readonly error?: string;
}

export interface DiscoveredProjectSeeds {
  readonly bareCsvFiles: readonly DiscoveredBareSeedCsv[];
  readonly specs: ReadonlyMap<string, ParsedSeedSpec>;
}

export interface DiscoverProjectSeedsOptions {
  /** Explicit legacy or CLI folder override, relative to the Project root. */
  readonly seedsDir?: string;
  readonly index?: ProjectIndex;
}

const NO_FOLLOW_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0);

function parseSeedYaml(content: string): unknown {
  const lineCounter = new LineCounter();
  try {
    return parseYaml(content, { uniqueKeys: true, prettyErrors: false, lineCounter });
  } catch (error) {
    const position = error instanceof YAMLError ? error.pos[0] : -1;
    if (position < 0) throw error;
    const { line, col } = lineCounter.linePos(position);
    const reason =
      error instanceof Error
        ? error.message.replace(/ at line \d+, column \d+$/u, '')
        : String(error);
    throw new Error(`${reason} at line ${line}, column ${col}`);
  }
}

const inside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
};

function projectPath(root: string, base: string, relativePath: string, owner: string): string {
  if (
    relativePath.length === 0 ||
    relativePath.includes('\\') ||
    relativePath.startsWith('/') ||
    /^[A-Za-z]:/u.test(relativePath)
  ) {
    throw new CommandError(`${owner}: seed CSV path must be a relative project path.`, 2);
  }
  const candidate = path.resolve(base, relativePath);
  if (!inside(root, candidate)) {
    throw new CommandError(`${owner}: seed CSV path escapes the Project root.`, 2);
  }
  return candidate;
}

function safeReadProjectFile(root: string, absolutePath: string, owner: string): Buffer {
  if (!inside(root, absolutePath)) {
    throw new CommandError(`${owner}: file path escapes the Project root.`, 2);
  }
  const relative = path.relative(root, absolutePath);
  let current = root;
  for (const [index, segment] of relative.split(path.sep).entries()) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      throw new CommandError(
        `${owner}: file does not exist (${error instanceof Error ? error.message : String(error)}).`,
        2
      );
    }
    if (stat.isSymbolicLink()) {
      throw new CommandError(`${owner}: symbolic links are not allowed.`, 2);
    }
    const segments = relative.split(path.sep);
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new CommandError(`${owner}: a parent path is not a directory.`, 2);
    }
    if (index === segments.length - 1 && !stat.isFile()) {
      throw new CommandError(`${owner}: expected a regular file.`, 2);
    }
  }

  const realPath = realpathSync(absolutePath);
  if (!inside(root, realPath)) {
    throw new CommandError(`${owner}: file escapes the Project root.`, 2);
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(absolutePath, NO_FOLLOW_FLAGS);
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new CommandError(`${owner}: expected a regular file.`, 2);
    const buffer = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (before.size !== after.size || buffer.byteLength !== after.size) {
      throw new CommandError(`${owner}: file changed while it was read.`, 2);
    }
    return buffer;
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError(`${owner}: cannot read file.`, 2);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function decodeUtf8(bytes: Buffer, owner: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CommandError(`${owner}: invalid UTF-8; re-encode the file as UTF-8.`, 2);
  }
}

function readSeedCsvContent(root: string, absolutePath: string, owner: string): string {
  return decodeUtf8(safeReadProjectFile(root, absolutePath, owner), owner);
}

function csvFilesUnderSeeds(root: string, seedsDir?: string): Map<string, string> {
  const found = new Map<string, string>();
  const base = seedsDir === undefined ? root : projectPath(root, root, seedsDir, 'seeds_dir');
  if (seedsDir !== undefined) {
    try {
      if (!lstatSync(base).isDirectory()) {
        throw new CommandError(`seeds_dir is not a directory: ${seedsDir}`, 2);
      }
    } catch (error) {
      if (error instanceof CommandError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return found;
      throw error;
    }
  }

  const visit = (directory: string, relativeDirectory: string, insideSeeds: boolean): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      throw new CommandError(
        `Cannot scan seed folder ${relativeDirectory || '.'}: ${error instanceof Error ? error.message : String(error)}`,
        2
      );
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      const isSeedFolder = insideSeeds || entry.name === 'seeds';
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        if (isSeedFolder || seedsDir !== undefined) {
          throw new CommandError(
            `${relativePath}: symbolic links are not allowed in seed folders.`,
            2
          );
        }
        continue;
      }
      if (stat.isDirectory()) {
        visit(absolutePath, relativePath, isSeedFolder);
        continue;
      }
      if (
        stat.isFile() &&
        isSeedFolder &&
        path.extname(entry.name).toLocaleLowerCase('en-US') === '.csv'
      ) {
        found.set(relativePath, absolutePath);
      }
    }
  };

  if (seedsDir === undefined) visit(base, '', false);
  else visit(base, path.relative(root, base).split(path.sep).join('/'), true);
  return found;
}

function parseSeedEntry(
  entry: ProjectIndexEntry,
  root: string,
  csvByPath: ReadonlyMap<string, string>,
  usedCsvPaths: Map<string, string>
): ParsedSeedSpec {
  const owner = entry.path;
  let document: unknown = entry.document;
  if (document === undefined) {
    try {
      document = parseSeedYaml(entry.content);
    } catch (error) {
      throw new CommandError(
        `${owner}: invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
        2
      );
    }
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new CommandError(`${owner}: seed spec must be a YAML mapping.`, 2);
  }
  const effectiveDocument = { ...(document as Record<string, unknown>), type: 'seed' };
  const parsed = SeedSpecSchema.safeParse(effectiveDocument);
  if (!parsed.success) {
    throw new CommandError(
      formatSpecValidationMessage('seed', owner, parsed.error, { schema: SeedSpecSchema }),
      2
    );
  }
  const specDirectory = path.dirname(path.resolve(root, ...owner.split('/')));
  const absoluteCsvPath = projectPath(root, specDirectory, parsed.data.payload.path, owner);
  if (!absoluteCsvPath.toLocaleLowerCase('en-US').endsWith('.csv')) {
    throw new CommandError(`${owner}: seed payload.path must reference a .csv file.`, 2);
  }
  const relativeCsvPath = path.relative(root, absoluteCsvPath).split(path.sep).join('/');
  const previous = usedCsvPaths.get(relativeCsvPath);
  if (previous) {
    throw new CommandError(
      `${owner}: CSV ${relativeCsvPath} is already assigned to another seed spec (${previous}).`,
      2
    );
  }
  const discoveredPath = csvByPath.get(relativeCsvPath);
  const csvPath = discoveredPath ?? absoluteCsvPath;
  let csvContent: string | undefined;
  let csvError: string | undefined;
  try {
    csvContent = readSeedCsvContent(root, csvPath, owner);
    readCsv(csvContent, {
      delimiter: parsed.data.payload.delimiter,
      maxRows: parsed.data.validation?.max_rows,
      expectedColumns: [],
    });
  } catch (error) {
    csvError = error instanceof Error ? error.message : String(error);
  }
  usedCsvPaths.set(relativeCsvPath, owner);
  return {
    name: parsed.data.name,
    spec: parsed.data,
    filePath: path.resolve(root, ...owner.split('/')),
    csvPath,
    ...(csvContent === undefined ? {} : { csvContent }),
    ...(csvError === undefined ? {} : { csvError }),
  };
}

/**
 * Discover bare CSV files and named seed specs from one Project scan. CSVs
 * below any exact `seeds/` path segment are identified by their path; only
 * specs carry semantic names and can participate in warehouse operations.
 */
export function discoverProjectSeeds(
  projectRoot: string,
  options: DiscoverProjectSeedsOptions = {}
): DiscoveredProjectSeeds {
  const root = realpathSync(projectRoot);
  const index = resolveProjectIndex(root, options.index);
  assertValidProjectIndex(index);
  const csvByPath = csvFilesUnderSeeds(root, options.seedsDir);
  const entries = entriesOfKind(index, 'seed').filter((entry) => {
    if (options.seedsDir === undefined) return true;
    const base = projectPath(root, root, options.seedsDir, 'seeds_dir');
    const absolute = path.resolve(root, ...entry.path.split('/'));
    return inside(base, absolute);
  });
  const usedCsvPaths = new Map<string, string>();
  const specs = new Map<string, ParsedSeedSpec>();
  for (const entry of entries) {
    const parsed = parseSeedEntry(entry, root, csvByPath, usedCsvPaths);
    const previous = specs.get(parsed.name);
    if (previous) {
      throw new CommandError(
        `Duplicate seed name "${parsed.name}" in ${previous.filePath} and ${parsed.filePath}.`,
        2
      );
    }
    specs.set(parsed.name, parsed);
  }

  const bareCsvFiles: DiscoveredBareSeedCsv[] = [];
  for (const [relativePath, absolutePath] of csvByPath) {
    if (usedCsvPaths.has(relativePath)) continue;
    try {
      const content = readSeedCsvContent(root, absolutePath, relativePath);
      const csv = readCsv(content, { delimiter: ',', expectedColumns: [] });
      if (csv.headers.length === 0) throw new Error('CSV must include a header row.');
      const normalized = new Set<string>();
      for (const header of csv.headers) {
        if (!header) throw new Error('CSV headers must not be empty.');
        const key = header.toLocaleLowerCase('en-US');
        if (normalized.has(key)) throw new Error(`Duplicate CSV header "${header}".`);
        normalized.add(key);
      }
      bareCsvFiles.push({ path: relativePath, headers: csv.headers, rowCount: csv.rowCount });
    } catch (error) {
      bareCsvFiles.push({
        path: relativePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { bareCsvFiles, specs };
}
