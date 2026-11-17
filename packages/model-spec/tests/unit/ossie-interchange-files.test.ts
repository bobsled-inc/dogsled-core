import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { parse, stringify } from 'yaml';
import { registerOssieCommand } from '../../src/commands/ossie.js';
import {
  readConversionInput,
  writeConversionFile,
  writeConversionFiles,
} from '../../src/interchange/files.js';
import { parseInterchangeInput, importOssieDocument } from '../../src/interchange/index.js';
import { indexProjectFiles } from '@bobsled-inc/project-index';
const folders: string[] = [];
const temp = () => {
  const p = mkdtempSync(join(tmpdir(), 'ossie-files-'));
  folders.push(p);
  return p;
};
const input = {
  version: '0.2.0.dev0',
  name: 'plain',
  datasets: [
    {
      name: 'orders',
      source: 'main.orders',
      fields: [
        { name: 'id', expression: { dialects: [{ dialect: 'ANSI_SQL', expression: 'id' }] } },
      ],
    },
  ],
};
afterEach(() => {
  folders.forEach((p) => rmSync(p, { recursive: true, force: true }));
  vi.restoreAllMocks();
  process.exitCode = 0;
});
describe('Ossie file boundary', () => {
  it('writes repairable native files without overwriting existing directories', () => {
    const result = importOssieDocument(input, {
      sourcePath: 'input.yml',
    });
    const root = temp(),
      out = join(root, 'converted');
    writeConversionFiles(result, out);
    expect(readFileSync(join(out, result.files[0]!.path), 'utf8')).toContain('type: source');
    expect(() => writeConversionFiles(result, out)).toThrow();
    const indexed = indexProjectFiles(result.files);
    expect(indexed.issues).toEqual([]);
    expect(indexed.entries.map((e) => e.kind)).toEqual(['source']);
  });
  it('rejects traversal, duplicate output paths, symlinks and unbounded input', () => {
    const root = temp();
    const result = importOssieDocument(input, {
      sourcePath: 'input.yml',
    });
    result.files[0]!.path = '../escape.yml';
    expect(() => writeConversionFiles(result, join(root, 'out'))).toThrow();
    expect(existsSync(join(root, 'out'))).toBe(false);
    const real = join(root, 'real.yml'),
      link = join(root, 'link.yml');
    writeFileSync(real, JSON.stringify(input));
    symlinkSync(real, link);
    expect(() => readConversionInput(link)).toThrow();
    expect(() => parseInterchangeInput('x'.repeat(1_000_001), 'a.yml')).toThrow();
    expect(() => parseInterchangeInput('a: &x [1]\nb: *x', 'a.yml')).toThrow();
    expect(() => parseInterchangeInput('{"__proto__":{}}', 'a.json')).toThrow();
  });
  it('rejects duplicate paths before writing and rolls back partial writes', () => {
    const root = temp();
    const result = importOssieDocument(input, { sourcePath: 'input.yml' });
    const duplicate = { ...result, files: [result.files[0]!, result.files[0]!] };
    expect(() => writeConversionFiles(duplicate, join(root, 'duplicate'))).toThrow(/duplicate/);
    expect(existsSync(join(root, 'duplicate'))).toBe(false);
    const collision = {
      ...result,
      files: [
        { ...result.files[0]!, path: 'a.yml' },
        { ...result.files[0]!, path: 'a.yml/child.yml' },
      ],
    };
    expect(() => writeConversionFiles(collision, join(root, 'partial'))).toThrow();
    expect(existsSync(join(root, 'partial'))).toBe(false);
  });
  it('writes one export file without replacing an existing path or symlink', () => {
    const root = temp();
    const result = importOssieDocument(input, { sourcePath: 'input.yml' });
    const output = join(root, 'sales.ossie.yml');
    writeConversionFile(result, output);
    expect(readFileSync(output, 'utf8')).toContain('type: source');
    expect(() => writeConversionFile(result, output)).toThrow();

    const link = join(root, 'linked.ossie.yml');
    symlinkSync(output, link);
    expect(() => writeConversionFile(result, link)).toThrow();
  });
  it.each(['--json', '--yaml', '--human'])(
    'reports incomplete CLI imports in %s and writes only with --out',
    async (format) => {
      const root = temp(),
        source = join(root, 'input.yml');
      writeFileSync(source, stringify(input));
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const command = new Command();
      registerOssieCommand(command);
      await command.parseAsync(['ossie', 'import', source, format, '--out', join(root, 'native')], {
        from: 'user',
      });
      expect(process.exitCode).toBe(2);
      expect(stdout).toHaveBeenCalled();
      expect(existsSync(join(root, 'native', 'sources'))).toBe(true);
    }
  );
  it('applies the default connection and a dataset binding from the CLI', async () => {
    const root = temp(),
      source = join(root, 'input.yml');
    writeFileSync(
      source,
      stringify({
        ...input,
        datasets: [
          ...input.datasets,
          {
            name: 'customers',
            source: 'main.customers',
            fields: [
              {
                name: 'id',
                expression: { dialects: [{ dialect: 'ANSI_SQL', expression: 'id' }] },
              },
            ],
          },
        ],
      })
    );
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const command = new Command();
    registerOssieCommand(command);
    await command.parseAsync(
      ['ossie', 'import', source, '--connection', 'default', '--bind', 'orders=warehouse'],
      { from: 'user' }
    );

    const report = JSON.parse(stdout.mock.calls.map(([value]) => String(value)).join(''));
    const documents = report.files.map((file: { document: unknown }) => file.document);
    expect(documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'orders', connection: 'warehouse' }),
        expect.objectContaining({ name: 'customers', connection: 'default' }),
      ])
    );
  });
  it('maps an imported connection from the CLI', async () => {
    const root = temp(),
      source = join(root, 'input.yml');
    writeFileSync(
      source,
      stringify({
        ...input,
        datasets: input.datasets.map((dataset) => ({
          ...dataset,
          custom_extensions: [
            {
              vendor_name: 'DOGSLED',
              data: JSON.stringify({
                extension_version: '2',
                kind: 'source',
                source_type: 'warehouse_table',
                connection: 'legacy',
              }),
            },
          ],
        })),
      })
    );
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const command = new Command();
    registerOssieCommand(command);
    await command.parseAsync(['ossie', 'import', source, '--map-connection', 'legacy=production'], {
      from: 'user',
    });

    const report = JSON.parse(stdout.mock.calls.map(([value]) => String(value)).join(''));
    expect(report.files[0].document).toMatchObject({ connection: 'production' });
  });
});

it('rejects the removed --kinds option', async () => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const command = new Command().exitOverride();
  registerOssieCommand(command);
  await expect(
    command.parseAsync(['ossie', 'import', 'unused.yml', '--kinds', 'unused.yml'], { from: 'user' })
  ).rejects.toMatchObject({ code: 'commander.unknownOption' });
});

it('exports and imports verified queries through the CLI', async () => {
  const root = temp();
  writeFileSync(
    join(root, 'warehouse.yml'),
    stringify({
      spec_version: '1',
      type: 'integration',
      name: 'warehouse',
      source_type: 'duckdb',
      connection: { schema: 'main' },
      auth: { type: 'file', path: './never-opened.duckdb' },
    })
  );
  writeFileSync(
    join(root, 'source.yml'),
    stringify({
      spec_version: '0.2',
      type: 'source',
      source_type: 'warehouse_table',
      name: 'orders',
      connection: 'warehouse',
      table: 'PUBLIC.ORDERS',
      schema: { columns: [{ name: 'id', type: 'INTEGER' }] },
    })
  );
  const query = {
    spec_version: '0.2',
    type: 'vq',
    name: 'all_orders',
    nlq: 'Show all orders',
    sql: 'SELECT * FROM {warehouse.orders}',
  };
  writeFileSync(join(root, 'query.yml'), stringify(query));
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const exportCommand = new Command();
  registerOssieCommand(exportCommand);
  const output = join(root, 'export.yml');
  await exportCommand.parseAsync(
    [
      'ossie',
      'export',
      '--all',
      '--project',
      root,
      '--name',
      'sales',
      '--ossie-version',
      '0.2.0.dev0',
      '--out',
      output,
    ],
    { from: 'user' }
  );
  expect(process.exitCode ?? 0, stdout.mock.calls.map(([value]) => String(value)).join('')).toBe(0);
  const document = parse(readFileSync(output, 'utf8'));
  expect(JSON.parse(document.custom_extensions[0].data).verified_queries).toEqual([query]);
  const importCommand = new Command();
  registerOssieCommand(importCommand);
  const destination = join(root, 'restored');
  await importCommand.parseAsync(['ossie', 'import', output, '--out', destination], {
    from: 'user',
  });
  expect(process.exitCode ?? 0).toBe(0);
  const result = importOssieDocument(document, { sourcePath: output });
  const queryFile = result.files.find((file) => file.document['type'] === 'vq')!;
  expect(parse(readFileSync(join(destination, queryFile.path), 'utf8'))).toEqual(query);
  expect(indexProjectFiles(result.files).entries.some((entry) => entry.kind === 'vq')).toBe(true);
});

it('writes a strict CLI export that only has relationship key warnings', async () => {
  const root = temp();
  writeFileSync(
    join(root, 'warehouse.yml'),
    stringify({
      spec_version: '1',
      type: 'integration',
      name: 'warehouse',
      source_type: 'duckdb',
      connection: { schema: 'main' },
      auth: { type: 'file', path: './never-opened.duckdb' },
    })
  );
  for (const [name, columns] of [
    ['orders', ['id', 'customer_id']],
    ['customers', ['id']],
  ] as const) {
    writeFileSync(
      join(root, `${name}.yml`),
      stringify({
        spec_version: '0.2',
        type: 'source',
        source_type: 'warehouse_table',
        name,
        connection: 'warehouse',
        table: `PUBLIC.${name.toUpperCase()}`,
        schema: { columns: columns.map((column) => ({ name: column, type: 'INTEGER' })) },
      })
    );
  }
  writeFileSync(
    join(root, 'orders_to_customers.yml'),
    stringify({
      spec_version: '0.2',
      type: 'relationship',
      name: 'orders_to_customers',
      left_model: 'warehouse.orders',
      right_model: 'warehouse.customers',
      join_columns: [{ left: 'customer_id', right: 'id' }],
      relationship_type: 'many_to_one',
    })
  );
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const command = new Command();
  registerOssieCommand(command);
  const output = join(root, 'export.yml');
  await command.parseAsync(
    [
      'ossie',
      'export',
      '--all',
      '--project',
      root,
      '--name',
      'sales',
      '--ossie-version',
      '0.2.0.dev0',
      '--strict',
      '--out',
      output,
    ],
    { from: 'user' }
  );
  const report = stdout.mock.calls.map(([value]) => String(value)).join('');
  expect(process.exitCode ?? 0, report).toBe(0);
  expect(JSON.parse(report)).toMatchObject({
    ok: true,
    ready: true,
    diagnostics: [{ code: 'relationship_target_key_missing', severity: 'warning' }],
  });
  expect(parse(readFileSync(output, 'utf8')).relationships).toHaveLength(1);
});
