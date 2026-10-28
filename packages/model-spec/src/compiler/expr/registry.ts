import { FUNCTION_CATALOG } from './functions.js';

import type { SupportedDialect } from '../dialect.js';
import type {
  ExpressionValueType,
  FunctionArgDef,
  FunctionCategory,
  FunctionSignature,
} from './functions.js';

export const EXPRESSION_REGISTRY_VERSION = '0.1.0';

export interface ExpressionFunctionManifestEntry {
  name: string;
  category: FunctionCategory;
  min_args: number;
  max_args: number | 'variadic';
  signature: FunctionSignature;
  description?: string;
  examples: string[];
  dialect_overrides: SupportedDialect[];
}

export interface ExpressionFunctionManifest {
  version: string;
  functions: ExpressionFunctionManifestEntry[];
}

function fallbackArg(index: number): FunctionArgDef {
  return { name: `arg${index + 1}`, type: 'unknown' };
}

function fallbackSignature(minArgs: number, maxArgs: number): FunctionSignature {
  const count = maxArgs === -1 ? Math.max(minArgs, 1) : maxArgs;
  const args = Array.from({ length: count }, (_, index) => ({
    ...fallbackArg(index),
    optional: index >= minArgs || undefined,
  }));
  return { args, returns: 'unknown' satisfies ExpressionValueType };
}

export function buildExpressionFunctionManifest(): ExpressionFunctionManifest {
  const functions = [...FUNCTION_CATALOG.values()]
    .map((fn) => ({
      name: fn.name,
      category: fn.category,
      min_args: fn.minArgs,
      max_args: fn.maxArgs === -1 ? ('variadic' as const) : fn.maxArgs,
      signature: fn.signature ?? fallbackSignature(fn.minArgs, fn.maxArgs),
      description: fn.description,
      examples: [...(fn.examples ?? [])],
      dialect_overrides: Object.keys(fn.emit).sort() as SupportedDialect[],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    version: EXPRESSION_REGISTRY_VERSION,
    functions,
  };
}

let _manifest: ExpressionFunctionManifest | undefined;
export function getExpressionFunctionManifest(): ExpressionFunctionManifest {
  return (_manifest ??= buildExpressionFunctionManifest());
}
