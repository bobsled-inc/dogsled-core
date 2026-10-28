import { CommandError } from '@bobsled-inc/protocol';

export function reviewerCommandArgs(command: string | string[]): [string, ...string[]] {
  const args: string[] = [];
  if (Array.isArray(command)) {
    args.push(...command);
  } else {
    let quote = '';
    let word = '';
    let started = false;
    for (let i = 0; i < command.length; i++) {
      const char = command[i]!;
      if (char === quote) {
        quote = '';
      } else if (char === '\\' && quote !== "'") {
        const next = command[++i];
        if (next === undefined) {
          throw new CommandError('Reviewer command has a trailing escape.', 2);
        }
        if (quote === '"' && !['"', '\\', '$', '`', '\n'].includes(next)) word += '\\';
        word += next;
        started = true;
      } else if (!quote && (char === '"' || char === "'")) {
        quote = char;
        started = true;
      } else if (!quote && /\s/.test(char)) {
        if (started) args.push(word);
        word = '';
        started = false;
      } else {
        if (!quote && /[|;&<>`$]/.test(char)) {
          throw new CommandError(
            'Reviewer command cannot contain shell operators; use an argv array.',
            2
          );
        }
        word += char;
        started = true;
      }
    }
    if (quote) throw new CommandError('Reviewer command has an unmatched quote.', 2);
    if (started) args.push(word);
  }
  if (!args[0]?.trim() || args.some((arg) => arg.includes('\0'))) {
    throw new CommandError('Reviewer command requires a local executable and valid arguments.', 2);
  }
  return args as [string, ...string[]];
}

export function reviewerCommandEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'TMPDIR', 'TMP', 'TEMP', 'LANG']) {
    if (env[key] !== undefined) result[key] = env[key];
  }
  return result;
}
