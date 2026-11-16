import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { CONFIG_FILE_NAME } from '../../../src/config.js';

describe('init command scaffolding', () => {
  let tmpDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dogsled-init-'));
    projectDir = path.join(tmpDir, 'test-project');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Import and run the init handler dynamically so we can test it
   * without spawning a CLI process.
   */
  async function runInit(dir: string, quiet = true): Promise<void> {
    // The init command is registered via registerInitCommand.
    // We can test the scaffolding by importing and calling the handler directly.
    // Since the handler is not exported, we'll use the Command API.
    const { Command } = await import('commander');
    const { registerInitCommand } = await import('../../../src/commands/init.js');

    const program = new Command();
    program.option('-q, --quiet');
    registerInitCommand(program);

    // Parse with the init command and directory argument
    const args = ['node', 'test', 'init', dir];
    if (quiet) args.push('-q');
    program.parse(args);
  }

  it('scaffolds source file with inline comments', async () => {
    await runInit(projectDir);
    const content = fs.readFileSync(
      path.join(projectDir, 'sources', 'example', 'raw_users.yml'),
      'utf-8'
    );
    expect(content).toContain('spec_version:');
    expect(content).toContain('# Required: spec format version');
    expect(content).toContain('# Logical connection name');
    expect(content).toContain('# Data quality tier');
  });

  it('scaffolds model file with inline comments', async () => {
    await runInit(projectDir);
    const content = fs.readFileSync(path.join(projectDir, 'models', 'stg_users.yml'), 'utf-8');
    expect(content).toContain('# Model name');
    expect(content).toContain('# Expression (t0 = source table alias)');
    expect(content).toContain('# view | table | incremental | ephemeral');
  });

  it('scaffolds .gitignore', async () => {
    await runInit(projectDir);
    const content = fs.readFileSync(path.join(projectDir, '.gitignore'), 'utf-8');
    expect(content).toContain('.bobsled/model-spec/');
    expect(content).toContain('dist/');
  });

  it('scaffolds model-spec.yml with commented-out directory overrides and integration pointer', async () => {
    await runInit(projectDir);
    const content = fs.readFileSync(path.join(projectDir, CONFIG_FILE_NAME), 'utf-8');
    expect(content).toContain('integrations/<handle>.yml');
    expect(content).toContain('dogsled model compile --integration');
    expect(content).toContain('# sources_dir: sources');
    expect(content).toContain('# models_dir: models');
    expect(content).toContain('# seeds_dir: seeds');
    expect(content).toContain('# entity_graph_dir: entity-graph');
    expect(content).toContain('# integrations_dir: integrations');
    expect(content).toContain('# targets_dir: targets');
    expect(content).toContain('# metrics_dir: metrics');
    expect(content).toContain('# relationships_dir: relationships');
    expect(content).toContain('# vqs_dir: vqs');
    expect(content).not.toMatch(/^dialect:/m);
    expect(content).not.toMatch(/^schema:/m);
  });

  it('scaffolds example metric, relationship placeholder, and VQ', async () => {
    await runInit(projectDir);
    const metricPath = path.join(projectDir, 'metrics', 'users_total.yml');
    const relationshipPath = path.join(projectDir, 'relationships', 'README.md');
    const vqPath = path.join(projectDir, 'vqs', 'users_created_this_month.yml');
    expect(fs.existsSync(metricPath)).toBe(true);
    expect(fs.existsSync(relationshipPath)).toBe(true);
    expect(fs.existsSync(vqPath)).toBe(true);

    expect(fs.readFileSync(metricPath, 'utf-8')).toContain('type: metric');
    expect(fs.readFileSync(vqPath, 'utf-8')).toContain('{stg_users}');
  });

  it('scaffolds an example DuckDB integration file', async () => {
    await runInit(projectDir);
    const integrationPath = path.join(projectDir, 'integrations', 'example.yml');
    expect(fs.existsSync(integrationPath)).toBe(true);
    const content = fs.readFileSync(integrationPath, 'utf-8');
    expect(content).toContain('source_type: duckdb');
    expect(content).toContain('name: example');
  });

  it('creates all expected files', async () => {
    await runInit(projectDir);
    expect(fs.existsSync(path.join(projectDir, 'sources', 'example', 'raw_users.yml'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'models', 'stg_users.yml'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'integrations', 'example.yml'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'metrics', 'users_total.yml'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'relationships', 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'vqs', 'users_created_this_month.yml'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, '.gitignore'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, CONFIG_FILE_NAME))).toBe(true);
  });
});
