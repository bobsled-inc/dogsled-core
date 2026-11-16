import { describe, expect, it, vi } from 'vitest';

import { buildProgram, handleCliError, runCli } from '../../src/index.js';
import { CommandError } from '@bobsled-inc/protocol';

describe('buildProgram', () => {
  it('wires the root command and subcommands', () => {
    const program = buildProgram();

    expect(program.name()).toBe('dogsled');
    expect(program.options.map((option) => option.long)).toContain('--project-root');
    expect(program.commands.map((command) => command.name())).toContain('extract');
    expect(program.commands.map((command) => command.name())).toContain('embed');
    expect(program.commands.map((command) => command.name())).toContain('load');
    expect(program.commands.map((command) => command.name())).toContain('model');
    expect(program.commands.map((command) => command.name())).toContain('entity-graph');
    expect(program.commands.map((command) => command.name())).toContain('pipeline');
    expect(program.commands.map((command) => command.name())).toContain('act');
    expect(program.commands.map((command) => command.name())).toContain('integrations');
    expect(program.commands.map((command) => command.name())).toContain('setup');
    expect(program.commands.map((command) => command.name())).toContain('skill');
    expect(program.commands.map((command) => command.name())).toContain('init');
    expect(program.commands.map((command) => command.name())).toContain('doctor');
    expect(program.commands.map((command) => command.name())).toContain('sync');
    expect(program.commands.map((command) => command.name())).toContain('query');
    expect(program.commands.map((command) => command.name())).toContain('source-query');
    expect(program.commands.map((command) => command.name())).toContain('learn');
  });

  it('registers commands in ETL workflow order (first-run → ETL → query/analysis → entity graph)', () => {
    const program = buildProgram();
    const names = program.commands.map((c) => c.name());

    const initIdx = names.indexOf('init');
    const doctorIdx = names.indexOf('doctor');
    const extractIdx = names.indexOf('extract');
    const queryIdx = names.indexOf('query');
    const entityGraphIdx = names.indexOf('entity-graph');

    expect(initIdx).toBeGreaterThanOrEqual(0);
    expect(initIdx).toBeLessThan(doctorIdx);
    expect(doctorIdx).toBeLessThan(extractIdx);
    expect(extractIdx).toBeLessThan(queryIdx);
    expect(queryIdx).toBeLessThan(entityGraphIdx);
  });

  it('no longer registers the retired platform commands', () => {
    const names = buildProgram().commands.map((command) => command.name());

    for (const retired of [
      'login',
      'pull',
      'validate',
      'plan',
      'apply',
      'ask',
      'sql',
      'get',
      'list',
      'create',
      'update',
      'delete',
      'describe',
    ]) {
      expect(names).not.toContain(retired);
    }
  });
});

describe('handleCliError', () => {
  it('maps CommandError to process.exitCode', () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    process.exitCode = undefined;
    handleCliError(new CommandError('bad input', 3));

    expect(process.exitCode).toBe(3);
    expect(stderrWrite).toHaveBeenCalledWith('bad input\n');

    stderrWrite.mockRestore();
  });

  it('maps generic Error to exit code 1', () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    process.exitCode = undefined;
    handleCliError(new Error('something broke'));

    expect(process.exitCode).toBe(1);
    expect(stderrWrite).toHaveBeenCalledWith('something broke\n');

    stderrWrite.mockRestore();
  });

  it('handles non-Error throwables without crashing', () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    process.exitCode = undefined;
    handleCliError('string error');

    expect(process.exitCode).toBe(1);
    expect(stderrWrite).toHaveBeenCalledWith('string error\n');

    stderrWrite.mockRestore();
  });

  it('handles null/undefined throwables with a fallback message', () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    process.exitCode = undefined;
    handleCliError(null);

    expect(process.exitCode).toBe(1);
    expect(stderrWrite).toHaveBeenCalledWith('An unknown error occurred\n');

    stderrWrite.mockRestore();
  });
});

describe('runCli', () => {
  it('uses delegated execution when a proxied subcommand is invoked', async () => {
    const delegation = await import('../../src/runtime/delegation.js');
    const delegatedSpy = vi
      .spyOn(delegation, 'maybeRunDelegatedCommand')
      .mockResolvedValue({ handled: true, exitCode: 5 });

    process.exitCode = undefined;
    await runCli(['extract', 'run']);

    expect(process.exitCode).toBe(5);

    delegatedSpy.mockRestore();
  });
});
