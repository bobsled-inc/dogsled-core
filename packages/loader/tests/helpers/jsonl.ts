import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export async function writeJsonl(
  filePath: string,
  records: Record<string, unknown>[]
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
}
