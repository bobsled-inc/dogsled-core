const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };

/** Reverses Snowflake literal escaping in one pass: doubled quotes and backslash sequences. */
export const unescapeSnowflake = (text: string): string =>
  text.replace(/''|\\(.)/gs, (match, next?: string) =>
    match === "''" ? "'" : (escapes[next!] ?? next!)
  );

/** The script inside `EXECUTE IMMEDIATE`, as Snowflake reads the literal. */
export const executeImmediateScript = (sql: string): string =>
  unescapeSnowflake(/^EXECUTE IMMEDIATE '(.*)';?$/s.exec(sql)![1]!);
