export function sanitizeStreamName(stream: string): string {
  return stream.replace(/[^A-Za-z0-9._-]/g, '_');
}
