#!/usr/bin/env node
// Emit deterministic SDK fixtures for local compatibility checks.
//
// Extracted from inline shell so fixture generation gets syntax highlighting,
// can be locally tested, and stays consistent across TypeScript and Python.
//
// Usage:
//   node scripts/ci/emit-sdk-fixture.mjs <lang> <out-dir>
//     <lang>     ts | python
//     <out-dir>  destination directory; created if missing.
//
// Side effects:
//   - Writes one file per emitted SDK module under <out-dir>/generated/.
//   - For `ts`, also writes <out-dir>/tsconfig.json suitable for
//     `tsc --noEmit`.
//   - Exits non-zero on any error.

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const [, , langArg, outArg] = process.argv;
if (!langArg || !outArg) {
  console.error('usage: node scripts/ci/emit-sdk-fixture.mjs <ts|python> <out-dir>');
  process.exit(2);
}
if (langArg !== 'ts' && langArg !== 'python') {
  console.error(`unsupported lang '${langArg}' (expected 'ts' or 'python')`);
  process.exit(2);
}

// Shared 3-entity / 2-entity fixture so the TS and Python matrix lanes
// validate the same canonical shape. Adjust here, not inline in the
// workflow YAML.
const TS_IR = {
  ir_version: '1.0',
  entities: [
    {
      name: 'Customer',
      primary_key: 'entity_id',
      branded_id_type: 'CustomerId',
      profile_attrs: [{ name: 'domain', type: 'string', nullable: false }],
      quality_columns: [
        'confidence',
        'freshness_age_seconds',
        'source_diversity',
        'profile_coverage',
      ],
    },
    {
      name: 'Document',
      primary_key: 'entity_id',
      branded_id_type: 'DocumentId',
      profile_attrs: [{ name: 'title', type: 'string', nullable: true }],
      quality_columns: [
        'confidence',
        'freshness_age_seconds',
        'source_diversity',
        'profile_coverage',
      ],
    },
    {
      name: 'Person',
      primary_key: 'entity_id',
      branded_id_type: 'PersonId',
      profile_attrs: [],
      quality_columns: [
        'confidence',
        'freshness_age_seconds',
        'source_diversity',
        'profile_coverage',
      ],
    },
  ],
  relationships: [],
  polymorphic_groups: [],
  dialect_capabilities: {
    supports_json_path: true,
    supports_full_text: true,
    supports_vector: true,
  },
};

// Python lane uses 2 entities (the third one with no profile_attrs has
// historically been TS-only smoke; adding it to Python doesn't change
// pyright coverage).
const PYTHON_IR = {
  ...TS_IR,
  entities: TS_IR.entities.slice(0, 2),
};

async function main() {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  const sdkDist = path.join(repoRoot, 'packages', 'sdk-codegen', 'dist', 'index.js');
  const { parseSdkIr, emitTypeScriptSdk, emitPythonSdk } = await import(sdkDist);

  const outDir = path.resolve(process.cwd(), outArg);
  mkdirSync(outDir, { recursive: true });

  if (langArg === 'ts') {
    const parsed = parseSdkIr(TS_IR);
    const files = emitTypeScriptSdk(parsed, { generatedAt: '2026-05-07T00:00:00Z' });
    const generated = path.join(outDir, 'generated');
    // Wipe ONLY the generated subdir between runs — don't clobber a
    // pinned-typescript install or workflow-managed package.json that
    // sits alongside generated/ in the same outDir.
    rmSync(generated, { recursive: true, force: true });
    for (const f of files) {
      const target = path.join(generated, f.path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, f.content);
    }
    // tsconfig.json colocated with the matrix's pinned-typescript install.
    // Matches the strict / NodeNext shape the consumer SDK targets.
    writeFileSync(
      path.join(outDir, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            noUncheckedIndexedAccess: true,
            noEmit: true,
            skipLibCheck: true,
          },
          include: ['generated/**/*.ts'],
        },
        null,
        2
      )
    );
    console.log(`Emitted ${files.length} TS file(s) to ${outDir}/generated`);
    return;
  }

  // langArg === 'python'
  const parsed = parseSdkIr(PYTHON_IR);
  const files = emitPythonSdk(parsed, { generatedAt: '2026-05-07T00:00:00Z' });
  const generated = path.join(outDir, 'sdk');
  rmSync(generated, { recursive: true, force: true });
  for (const f of files) {
    const target = path.join(generated, f.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, f.content);
  }
  console.log(`Emitted ${files.length} Python file(s) to ${outDir}/sdk`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
