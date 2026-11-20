export function sanitizeStreamName(stream: string): string {
  return stream.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Makes a name from a sender safe to print: control and format characters, and line and
 * paragraph separators, become \uXXXX, so a name cannot rewrite a terminal or a log line.
 */
export function escapeUnprintable(text: string): string {
  return text.replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (char) => `\\u${char.codePointAt(0)!.toString(16).padStart(4, '0')}`
  );
}
