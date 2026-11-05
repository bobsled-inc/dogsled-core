import { DogsledRuntimeError, type DogsledRuntimeErrorKind } from '@bobsled-inc/protocol';

/**
 * Connection-level SFTP failure codes. Apps switch on `error.code` to show a
 * plain message; per-file problems stay ExtractorDataError instead.
 */
export const SFTP_ERROR_CODES = [
  'SFTP_HOST_KEY_MISMATCH',
  'SFTP_HOST_KEY_TYPE_UNAVAILABLE',
  'SFTP_AUTH_FAILED',
  'SFTP_NOT_SSH',
  'SFTP_NO_MATCHING_ALGORITHM',
  'SFTP_SUBSYSTEM_UNAVAILABLE',
  'SFTP_CONNECT_FAILED',
  'SFTP_TIMEOUT',
  'SFTP_CONNECTION_LOST',
  'SFTP_CANCELLED',
  'SFTP_PATH_NOT_FOUND',
  'SFTP_PERMISSION_DENIED',
  'SFTP_LOCAL_WRITE_FAILED',
] as const;
export type SftpErrorCode = (typeof SFTP_ERROR_CODES)[number];

const SPECS: Record<SftpErrorCode, { kind: DogsledRuntimeErrorKind; retryable: boolean }> = {
  SFTP_HOST_KEY_MISMATCH: { kind: 'validation', retryable: false },
  SFTP_HOST_KEY_TYPE_UNAVAILABLE: { kind: 'validation', retryable: false },
  SFTP_AUTH_FAILED: { kind: 'auth', retryable: false },
  SFTP_NOT_SSH: { kind: 'validation', retryable: false },
  SFTP_NO_MATCHING_ALGORITHM: { kind: 'provider', retryable: false },
  SFTP_SUBSYSTEM_UNAVAILABLE: { kind: 'provider', retryable: false },
  SFTP_CONNECT_FAILED: { kind: 'provider', retryable: true },
  SFTP_TIMEOUT: { kind: 'timeout', retryable: true },
  SFTP_CONNECTION_LOST: { kind: 'provider', retryable: true },
  SFTP_CANCELLED: { kind: 'cancellation', retryable: false },
  SFTP_PATH_NOT_FOUND: { kind: 'validation', retryable: false },
  SFTP_PERMISSION_DENIED: { kind: 'auth', retryable: false },
  SFTP_LOCAL_WRITE_FAILED: { kind: 'internal', retryable: false },
};

export function sftpError(code: SftpErrorCode, op: string, cause?: unknown): DogsledRuntimeError {
  return new DogsledRuntimeError({
    ...SPECS[code],
    code,
    operation: `extractor.sftp.${op}`,
    cause: cause instanceof Error ? cause : undefined,
  });
}
