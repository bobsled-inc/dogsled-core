import * as fs from 'node:fs';
import * as path from 'node:path';

const distDir = path.resolve(import.meta.dirname, '..', 'dist');
const { buildExpressionFunctionManifest } = await import('../dist/compiler/index.js');

fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(
  path.join(distDir, 'expressions.json'),
  `${JSON.stringify(buildExpressionFunctionManifest(), null, 2)}\n`,
  'utf-8'
);
