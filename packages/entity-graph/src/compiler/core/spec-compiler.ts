import type { SupportedDialect } from '@bobsled-inc/model-spec';

import type { SqlStatement } from '../identity/types.js';

export interface SpecCompileContext {
  dialect: SupportedDialect;
  targetSchema: string;
}

export interface SpecCompileResult {
  statements: SqlStatement[];
  warnings: string[];
}

export interface SpecCompiler<TSpec> {
  readonly type: string;
  compile(spec: TSpec, context: SpecCompileContext): SpecCompileResult;
}
