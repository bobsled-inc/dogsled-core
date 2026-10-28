import { deepStrictEqual, ok } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, it } from 'vitest';

import { INLINED_AI_DEPENDENCY_NAMES } from '../../scripts/release/package-set.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');

describe('AI package packaging', () => {
  it('keeps every zod-peer-bearing provider in the tsup bundle list', () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(repoRoot, 'packages/ai/package.json'), 'utf8')
    );
    const tsupConfig = readFileSync(path.join(repoRoot, 'packages/ai/tsup.config.ts'), 'utf8');

    deepStrictEqual(INLINED_AI_DEPENDENCY_NAMES, [
      '@ai-sdk/amazon-bedrock',
      '@ai-sdk/anthropic',
      '@ai-sdk/google',
      '@ai-sdk/openai',
      '@openrouter/ai-sdk-provider',
      'ai',
      'ollama-ai-provider',
    ]);
    for (const dependencyName of INLINED_AI_DEPENDENCY_NAMES) {
      ok(
        packageJson.dependencies?.[dependencyName],
        `AI package must declare inlined dependency ${dependencyName}`
      );
    }
    ok(
      tsupConfig.includes('noExternal: INLINED_AI_DEPENDENCY_NAMES'),
      'AI tsup config must bundle the reviewed provider dependency list'
    );
    ok(
      INLINED_AI_DEPENDENCY_NAMES.includes('ollama-ai-provider'),
      'Ollama must remain available through the bundled provider surface'
    );
  });
});
