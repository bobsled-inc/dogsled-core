import {
  CommandError,
  DogsledRuntimeError,
  type DogsledRuntimeErrorOptions,
} from '@bobsled-inc/protocol';

export { CommandError, DogsledRuntimeError };
export type { DogsledRuntimeErrorOptions };

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
): DogsledRuntimeError {
  if (cause instanceof DogsledRuntimeError) return cause;
  const error = cause instanceof Error ? cause : new Error(String(cause));
  if (error instanceof CommandError) {
    return new DogsledRuntimeError({
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
    return new DogsledRuntimeError({
      kind: 'internal',
      code: `${context.codePrefix}_FILESYSTEM_${errno}`,
      operation: context.operation,
      retryable: false,
      cause: error,
    });
  }
  return new DogsledRuntimeError({
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
