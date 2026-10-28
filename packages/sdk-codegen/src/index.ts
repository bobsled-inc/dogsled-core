export { SDK_CODEGEN_VERSION, SDK_IR_VERSION, SdkIrSchema, parseSdkIr } from './ir/schema.js';
export type {
  SdkIr,
  SdkEntity,
  SdkRelationship,
  SdkProfileAttr,
  SdkAttrType,
  SdkDialectCapabilities,
  SdkOntology,
} from './ir/schema.js';
export { readIr, type ReadIrOptions } from './ir/reader.js';
export { emitTypeScriptSdk, type EmitTypeScriptOptions } from './emitters/typescript/index.js';
export { emitPythonSdk, type EmitPythonOptions } from './emitters/python/index.js';
export type { EmittedFile } from './emitters/typescript/index.js';
export {
  runSdkGenerate,
  createSdkGenerateCommand,
  registerSdkCommand,
} from './cli/sdk-generate-cmd.js';
export type {
  SdkGenerateInvocation,
  SdkGenerateOptions,
  SdkGenerateResult,
} from './cli/sdk-generate-cmd.js';
