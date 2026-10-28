import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import ts from 'typescript';
import { expect, it } from 'vitest';

const SURFACE = `import {
  generateProjectManifest,
  loadDogsledConfig,
  loadProjectPipelineConfig,
  resolveProjectPipelines,
  validateProjectPipelines,
} from '@bobsled-inc/dogsled/manifest';
import { loadDogsledConfig as loadRootDogsledConfig } from '@bobsled-inc/dogsled';
import {
  buildProjectSkillReferenceCatalog,
  buildProjectSkillsManifest,
  getProjectSkill,
  loadProjectSkills,
  validateProjectSkills,
  type ProjectSkillHostDeclarations,
  type ProjectSkillsOptions,
} from '@bobsled-inc/dogsled/project-skills';
import {
  parseReverseEtlProject,
  type ReverseEtlHostDeclarations,
} from '@bobsled-inc/dogsled/reverse-etl';
import { runProjectPipeline } from '@bobsled-inc/dogsled/pipeline';
import { createAgenticHost, createJevExecutor } from '@bobsled-inc/dogsled/agentic';
import {
  resolveAgenticModel,
  type AgenticHost,
  type ExperimentalAgenticProbe,
} from '@bobsled-inc/dogsled/model-spec/agentic';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Check<T extends { hostManagedModelAuth?: unknown }> = [
  Same<NonNullable<T['hostManagedModelAuth']>, boolean>,
  Omit<T, 'hostManagedModelAuth'> extends T ? true : false,
];
type Declarations<T extends { declaredEnvNames?: unknown; hostManagedModelAuth?: unknown }> = [
  Same<NonNullable<T['declaredEnvNames']>, readonly string[]>,
  Same<NonNullable<T['hostManagedModelAuth']>, boolean>,
  {} extends T ? true : false,
];

export const surface: [
  Check<Parameters<typeof validateProjectPipelines>[0]>,
  Check<Parameters<typeof resolveProjectPipelines>[0]>,
  Check<Parameters<typeof loadProjectPipelineConfig>[0]>,
  Check<Parameters<typeof generateProjectManifest>[0]>,
  Check<Parameters<typeof runProjectPipeline>[0]>,
  Check<Parameters<typeof createAgenticHost>[0]>,
  Check<Parameters<typeof resolveAgenticModel>[1]>,
  Check<AgenticHost>,
  Check<ExperimentalAgenticProbe>,
] = [
  [true, true],
  [true, true],
  [true, true],
  [true, true],
  [true, true],
  [true, true],
  [true, true],
  [true, true],
  [true, true],
];

export const declarationSurface: [
  Declarations<NonNullable<Parameters<typeof buildProjectSkillReferenceCatalog>[2]>>,
  Declarations<NonNullable<Parameters<typeof loadProjectSkills>[1]>>,
  Declarations<NonNullable<Parameters<typeof getProjectSkill>[2]>>,
  Declarations<NonNullable<Parameters<typeof validateProjectSkills>[1]>>,
  Declarations<NonNullable<Parameters<typeof buildProjectSkillsManifest>[1]>>,
  Declarations<ProjectSkillsOptions>,
  Declarations<ProjectSkillHostDeclarations>,
  Declarations<NonNullable<Parameters<typeof parseReverseEtlProject>[2]>>,
  Declarations<ReverseEtlHostDeclarations>,
  Declarations<NonNullable<Parameters<typeof loadDogsledConfig>[1]>>,
  Declarations<NonNullable<Parameters<typeof loadRootDogsledConfig>[1]>>,
] = [
  [true, true, true],
  [true, true, true],
  [true, true, true],
  [true, true, true],
  [true, true, true],
  [true, true, true],
  [true, true, true],
  [true, true, true],
  [true, true, true],
  [true, true, true],
  [true, true, true],
];

// @ts-expect-error The option is a boolean, not a list of names.
loadProjectSkills('.', { hostManagedModelAuth: ['AI_GATEWAY_API_KEY'] });
// @ts-expect-error Declared names are a list of names.
parseReverseEtlProject('.', undefined, { declaredEnvNames: 'AI_GATEWAY_API_KEY' });

// @ts-expect-error The option is a boolean, not a list of names.
loadProjectPipelineConfig({ projectRoot: '.', hostManagedModelAuth: ['AI_GATEWAY_API_KEY'] });

type JevOptions = Parameters<typeof createJevExecutor>[0];
export const jevSurface: [{} extends JevOptions ? false : true, undefined extends JevOptions ? false : true] = [true, true];
createJevExecutor({ secretResolver: { resolve: async () => 'key' } });
// @ts-expect-error Jev requires an explicit secretResolver.
createJevExecutor();
// @ts-expect-error Jev requires an explicit secretResolver.
createJevExecutor({ fetch });
`;

it('exposes host declaration and secret resolver options on every public host entry point', () => {
  const packageRoot = path.resolve(import.meta.dirname, '../..');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dogsled-host-model-auth-'));
  try {
    mkdirSync(path.join(directory, 'node_modules/@bobsled-inc'), { recursive: true });
    symlinkSync(packageRoot, path.join(directory, 'node_modules/@bobsled-inc/dogsled'), 'dir');
    writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}\n');
    const file = path.join(directory, 'surface.ts');
    writeFileSync(file, SURFACE);
    const program = ts.createProgram([file], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    });
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    expect(diagnostics).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
