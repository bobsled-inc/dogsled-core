import { readFileSync } from 'node:fs';

import {
  createDocPointer,
  findPackageForFile,
  listFilesRecursively,
  listWorkspacePackages,
  rootAgentsPath,
} from './shared.mjs';

const SOFT_LINE_LIMIT = 700;
const HARD_LINE_LIMIT = 1200;
const SOFT_BYTE_LIMIT = 32_000;
const HARD_BYTE_LIMIT = 48_000;

const warnings = [];
const errors = [];

for (const pkg of listWorkspacePackages()) {
  const sourceFiles = listFilesRecursively(
    pkg.dir,
    (filePath) => filePath.startsWith(`${pkg.dir}/src/`) && filePath.endsWith('.ts')
  );

  for (const filePath of sourceFiles) {
    const content = readFileSync(filePath, 'utf8');

    // Exempt machine-generated files. Convention: emit an `@generated`
    // marker in the file header (looked at by linguist, formatters, etc.).
    // Generators commit a fresh copy on every regeneration, so size growth
    // tracks the source data — not human-authored complexity — and the
    // soft/hard caps don't carry their intended meaning.
    //
    // Restrict the lookup to the first 10 lines so the marker has to live
    // in the file's header — a comment / docstring / string literal further
    // down can't dodge the cap.
    const header = content.split('\n', 10).join('\n');
    if (header.includes('@generated') || header.includes('GENERATED FILE')) {
      continue;
    }

    const lineCount = content.split('\n').length;
    const byteCount = Buffer.byteLength(content, 'utf8');

    if (lineCount > HARD_LINE_LIMIT || byteCount > HARD_BYTE_LIMIT) {
      errors.push({ filePath, lineCount, byteCount, pkg });
      continue;
    }

    if (lineCount > SOFT_LINE_LIMIT || byteCount > SOFT_BYTE_LIMIT) {
      warnings.push({ filePath, lineCount, byteCount, pkg });
    }
  }
}

for (const warning of warnings) {
  const message = `${warning.filePath} is ${warning.lineCount} lines / ${warning.byteCount} bytes. Split helpers, types, or command phases into sibling modules before adding more logic. See ${createDocPointer(rootAgentsPath, 'Code Standards')} and ${createDocPointer(warning.pkg.agentsPath)}.`;
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log(`::warning file=${warning.filePath}::${message}`);
  } else {
    console.log(`warning: ${message}`);
  }
}

for (const error of errors) {
  const message = `${error.filePath} exceeded the hard source-file budget at ${error.lineCount} lines / ${error.byteCount} bytes. Split the module before merging more changes. See ${createDocPointer(rootAgentsPath, 'Code Standards')} and ${createDocPointer(error.pkg.agentsPath)}.`;
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log(`::error file=${error.filePath}::${message}`);
  } else {
    console.error(`error: ${message}`);
  }
}

console.log(
  `File-size summary: ${warnings.length} warning(s), ${errors.length} hard violation(s). Soft limit ${SOFT_LINE_LIMIT} lines / ${SOFT_BYTE_LIMIT} bytes. Hard limit ${HARD_LINE_LIMIT} lines / ${HARD_BYTE_LIMIT} bytes.`
);

if (errors.length > 0) {
  process.exitCode = 1;
}
