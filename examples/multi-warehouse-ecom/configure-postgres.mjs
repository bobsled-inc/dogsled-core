import { readFile, writeFile } from 'node:fs/promises';
const port = Number(process.env.SHOWCASE_PG_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('Set SHOWCASE_PG_PORT to the local Docker port');
for (const file of ['integrations/local_pg.yml', 'destinations.json']) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') continue;
    throw error;
  }
  await writeFile(
    file,
    file.endsWith('.json')
      ? JSON.stringify(
          JSON.parse(text).map((dest) => (dest.type === 'postgres' ? { ...dest, port } : dest)),
          null,
          2
        ) + '\n'
      : text.replace(/(port: )\d+/, '$1' + port)
  );
}
