import type { Writable } from 'node:stream';

import type { CommandContext } from './common.js';

export async function writeCommandJson(
  ctx: Pick<CommandContext, 'quiet'>,
  payload: unknown,
  stream: Writable = process.stdout
): Promise<void> {
  await writeCommandText(ctx, JSON.stringify(payload, null, 2) + '\n', stream);
}

export async function writeCommandLines(
  ctx: Pick<CommandContext, 'quiet'>,
  lines: readonly string[],
  stream: Writable = process.stdout
): Promise<void> {
  await writeCommandText(ctx, lines.join('\n') + (lines.length > 0 ? '\n' : ''), stream);
}

export async function writeCommandText(
  ctx: Pick<CommandContext, 'quiet'>,
  text: string,
  stream: Writable = process.stdout
): Promise<void> {
  if (ctx.quiet || text.length === 0) {
    return;
  }
  if (stream.write(text)) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onDrain = () => {
      stream.removeListener('error', onError);
      resolve();
    };
    const onError = (error: Error) => {
      stream.removeListener('drain', onDrain);
      reject(error);
    };
    stream.once('drain', onDrain);
    stream.once('error', onError);
  });
}
