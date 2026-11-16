import {
  CommandError,
  BobsledRuntimeError,
  type BobsledRuntimeErrorOptions,
} from '@bobsled-inc/protocol';

export { CommandError, BobsledRuntimeError };
export type { BobsledRuntimeErrorOptions };

export interface ModelSpecRuntimeErrorContext {
  codePrefix: string;
  operation: string;
}

const LOAD_ERROR_CONTEXT: ModelSpecRuntimeErrorContext = {
  codePrefix: 'MODEL_PROJECT_LOAD',
  operation: 'model.project.load',
};

export function toModelSpecRuntimeError(
  cause: unknown,
  context: ModelSpecRuntimeErrorContext = LOAD_ERROR_CONTEXT
): BobsledRuntimeError {
  if (cause instanceof BobsledRuntimeError) return cause;
  const error = cause instanceof Error ? cause : new Error(String(cause));
  if (error instanceof CommandError) {
    return new BobsledRuntimeError({
      kind: error.exitCode === 2 ? 'validation' : 'internal',
      code:
        error.exitCode === 2
          ? `${context.codePrefix}_VALIDATION_FAILED`
          : `${context.codePrefix}_RUNTIME_FAILED`,
      operation: context.operation,
      retryable: false,
      cause: error,
    });
  }
  const errno = (error as NodeJS.ErrnoException).code;
  if (typeof errno === 'string') {
    return new BobsledRuntimeError({
      kind: 'internal',
      code: `${context.codePrefix}_FILESYSTEM_${errno}`,
      operation: context.operation,
      retryable: false,
      cause: error,
    });
  }
  return new BobsledRuntimeError({
    kind: error.name === 'AbortError' ? 'cancellation' : 'internal',
    code:
      error.name === 'AbortError'
        ? `${context.codePrefix}_CANCELLED`
        : `${context.codePrefix}_FAILURE`,
    operation: context.operation,
    retryable: false,
    cause: error,
  });
}
