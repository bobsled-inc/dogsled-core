export function redactSnowflakeSecret(value: string, secret: string | undefined): string {
  if (!secret || secret.length === 0) {
    return value;
  }
  return value.split(secret).join('[REDACTED]');
}

export function copySnowflakeErrorLike(
  error: Error,
  message: string,
  sanitizeErrorMessage: (value: string) => string
): Error {
  const sanitized = new Error(message);
  const errorWithCode = error as Error & { code?: unknown };
  const sanitizedWithCode = sanitized as Error & { code?: unknown };
  if (typeof errorWithCode.code === 'string') {
    sanitizedWithCode.code = sanitizeErrorMessage(errorWithCode.code);
  } else if (typeof errorWithCode.code === 'number') {
    sanitizedWithCode.code = errorWithCode.code;
  }
  return sanitized;
}
