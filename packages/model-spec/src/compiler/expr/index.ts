/**
 * Expression DSL — barrel export.
 *
 * Re-exports the public API for parsing, emitting, and walking
 * dialect-neutral expression ASTs.
 */

export { parseExprField, parseWindowFrameClause, tryParseExpr } from './parser.js';
export type { ParseResult } from './parser.js';

export { emitExpr, emitOrderByItems, emitWindowFrame, renderOrderByTerm } from './emitter.js';

export { walkExpr, mapExpr } from './walker.js';

export { FUNCTION_CATALOG } from './functions.js';
export type {
  FunctionDef,
  FunctionCategory,
  DialectEmitter,
  ExpressionValueType,
  FunctionArgDef,
  FunctionSignature,
} from './functions.js';

export {
  getExpressionFunctionManifest,
  EXPRESSION_REGISTRY_VERSION,
  buildExpressionFunctionManifest,
} from './registry.js';
export type { ExpressionFunctionManifest, ExpressionFunctionManifestEntry } from './registry.js';

export type {
  BobsledExpr,
  BobsledExprKind,
  BinaryOp,
  UnaryOp,
  ArithmeticOp,
  ComparisonOp,
  LogicalOp,
  StringOp,
  TypeRef,
  CaseWhen,
  ColumnRefExpr,
  LiteralStringExpr,
  LiteralNumberExpr,
  LiteralBooleanExpr,
  LiteralNullExpr,
  LiteralStarExpr,
  BinaryOpExpr,
  UnaryOpExpr,
  FunctionCallExpr,
  CastExpr,
  JsonPathAccessExpr,
  JsonPathStep,
  CaseExpr,
  BetweenExpr,
  InListExpr,
  InSubqueryExpr,
  IntervalExpr,
  IntervalUnit,
  IsNullExpr,
  ParenthesizedExpr,
  RawSqlExpr,
  SubqueryExpr,
  ExistsExpr,
  WindowExpr,
  WindowOrderByItem,
  WindowFrameSpec,
  FrameBound,
  FrameExclude,
} from './types.js';
