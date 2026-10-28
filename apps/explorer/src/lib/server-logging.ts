export function logServerError(
  scope: string,
  error: unknown,
  details?: Record<string, unknown>
): void {
  const payload = {
    level: 'error',
    scope,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    details,
  };

  process.stderr.write(JSON.stringify(payload) + '\n');
}
