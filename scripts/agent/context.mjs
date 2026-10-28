import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AgentContextError,
  buildAgentContext,
  discoverChangedPaths,
  normalizeRepoPath,
  serializeContext,
} from './context-lib.mjs';

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), '..', '..');

function parseArgs(argv) {
  const options = {
    baseRef: 'origin/main',
    format: 'text',
    paths: [],
    staged: false,
  };
  let pathsMode = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--json') {
      options.format = 'json';
      pathsMode = false;
    } else if (arg === '--yaml') {
      options.format = 'yaml';
      pathsMode = false;
    } else if (arg === '--staged') {
      options.staged = true;
      pathsMode = false;
    } else if (arg === '--base') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) {
        throw new AgentContextError('--base requires a Git ref.');
      }
      if (value.startsWith('-') || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new AgentContextError(
          '--base must be a safe Git revision without control characters.'
        );
      }
      options.baseRef = value;
      pathsMode = false;
    } else if (arg === '--paths') {
      pathsMode = true;
    } else if (pathsMode) {
      options.paths.push(arg);
    } else {
      throw new AgentContextError(`Unknown argument: ${arg}`);
    }
  }

  if (options.paths.length && options.staged) {
    throw new AgentContextError('--paths and --staged are mutually exclusive.');
  }
  return options;
}

function renderError(error, format) {
  const sanitize = (value) =>
    String(value)
      .replaceAll(repoRoot, '.')
      .replace(/[\u0000-\u001f\u007f]/g, ' ');
  const payload = {
    schemaVersion: 1,
    ok: false,
    error: {
      code: 'AGENT_CONTEXT_INVALID',
      message: sanitize(error.message),
      details: (error.details ?? []).map(sanitize),
    },
  };
  if (format === 'json') return `${JSON.stringify(payload, null, 2)}\n`;
  if (format === 'yaml') return serializeContext(payload, 'yaml');
  return `Agent context failed: ${payload.error.message}${
    payload.error.details.length
      ? `\n${payload.error.details.map((item) => `- ${item}`).join('\n')}`
      : ''
  }\n`;
}

let format = process.argv.includes('--json')
  ? 'json'
  : process.argv.includes('--yaml')
    ? 'yaml'
    : 'text';

try {
  const options = parseArgs(process.argv.slice(2));
  format = options.format;
  const discovery = options.paths.length
    ? {
        baseRef: null,
        mode: 'paths',
        paths: options.paths.map((candidate) => normalizeRepoPath(repoRoot, candidate)),
      }
    : discoverChangedPaths({
        repoRoot,
        baseRef: options.baseRef,
        staged: options.staged,
      });
  const context = buildAgentContext({ repoRoot, discovery });
  process.stdout.write(serializeContext(context, options.format));
} catch (error) {
  const normalized =
    error instanceof AgentContextError
      ? error
      : new AgentContextError('Agent context failed unexpectedly.', [
          'Inspect the repository configuration and rerun the command.',
        ]);
  process.stderr.write(renderError(normalized, format));
  process.exitCode = 2;
}
