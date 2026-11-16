import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { maybeRunDelegatedCommand, runDelegatedCli } from '../../../src/runtime/delegation.js';

import type { ChildProcess } from 'node:child_process';
import type { Mock } from 'vitest';

vi.mock('../../../src/runtime/workspace.js', () => ({
  resolveCliInvocation: vi.fn((target: string, _metaUrl: string, args: string[]) => ({
    command: `${target}-cli`,
    args,
  })),
}));

vi.mock('@bobsled-inc/integrations', () => ({
  getIntegrationsDir: vi.fn(() => '/mock/integrations'),
}));

function createMockChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stdin = null;
  child.stdout = null;
  child.stderr = null;
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  return child;
}

describe('runDelegatedCli', () => {
  it('spawns the resolved CLI and returns its exit code', async () => {
    const child = createMockChild();
    const spawn = vi.fn().mockReturnValue(child) as Mock;

    const exitCodePromise = runDelegatedCli('extract', ['run', '--integration', 'github'], {
      metaUrl: 'file:///dogsled/tests/mock.ts',
      spawn,
    });

    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    child.emit('close', 0);

    const exitCode = await exitCodePromise;
    expect(exitCode).toBe(0);
    expect(spawn).toHaveBeenCalledWith(
      'extract-cli',
      ['run', '--integration', 'github'],
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('returns non-zero exit code from failed subprocess', async () => {
    const child = createMockChild();
    const spawn = vi.fn().mockReturnValue(child) as Mock;

    const exitCodePromise = runDelegatedCli('model', ['compile'], {
      metaUrl: 'file:///dogsled/tests/mock.ts',
      spawn,
    });

    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    child.emit('close', 2);

    const exitCode = await exitCodePromise;
    expect(exitCode).toBe(2);
  });
});

describe('maybeRunDelegatedCommand', () => {
  function makeDeps(exitCode = 0) {
    const child = createMockChild();
    const spawn = vi.fn().mockImplementation(() => {
      queueMicrotask(() => child.emit('close', exitCode));
      return child;
    }) as Mock;
    return { metaUrl: 'file:///dogsled/tests/mock.ts', spawn };
  }

  it.each(['estimate', 'check', 'commit-state', 'activate', 'mcp'])(
    'delegates extractor %s after standalone bins are removed',
    async (command) => {
      const deps = makeDeps();
      const result = await maybeRunDelegatedCommand(['extract', command, '--help'], deps);
      expect(result).toEqual({ handled: true, exitCode: 0 });
      expect(deps.spawn).toHaveBeenCalledWith(
        'extract-cli',
        [command, '--help'],
        expect.objectContaining({ stdio: 'inherit' })
      );
    }
  );

  it('returns handled: false for unknown groups', async () => {
    const result = await maybeRunDelegatedCommand(['pipeline', '--integration', 'x'], makeDeps());
    expect(result).toEqual({ handled: false });
  });

  it('returns handled: false for an empty argv', async () => {
    const result = await maybeRunDelegatedCommand([], makeDeps());
    expect(result).toEqual({ handled: false });
  });

  describe('help flags', () => {
    it.each(['--help', '-h', 'help'])('returns handled: false for extract %s', async (helpArg) => {
      const result = await maybeRunDelegatedCommand(['extract', helpArg], makeDeps());
      expect(result).toEqual({ handled: false });
    });

    it.each(['--help', '-h', 'help'])('returns handled: false for load %s', async (helpArg) => {
      const result = await maybeRunDelegatedCommand(['load', helpArg], makeDeps());
      expect(result).toEqual({ handled: false });
    });

    it.each(['--help', '-h', 'help'])('returns handled: false for model %s', async (helpArg) => {
      const result = await maybeRunDelegatedCommand(['model', helpArg], makeDeps());
      expect(result).toEqual({ handled: false });
    });

    it.each(['--help', '-h', 'help'])(
      'returns handled: false for entity-graph %s',
      async (helpArg) => {
        const result = await maybeRunDelegatedCommand(['entity-graph', helpArg], makeDeps());
        expect(result).toEqual({ handled: false });
      }
    );

    it.each(['--help', '-h', 'help'])('returns handled: false for embed %s', async (helpArg) => {
      const result = await maybeRunDelegatedCommand(['embed', helpArg], makeDeps());
      expect(result).toEqual({ handled: false });
    });
  });

  describe('extract delegation', () => {
    it.each(['run', 'health-check'])('delegates the %s subcommand', async (subcommand) => {
      const deps = makeDeps(0);
      const result = await maybeRunDelegatedCommand(
        ['extract', subcommand, '--integration', 'x'],
        deps
      );

      expect(result).toEqual({ handled: true, exitCode: 0 });
      expect(deps.spawn).toHaveBeenCalled();
    });

    it('returns handled: false for unrecognized subcommands', async () => {
      const result = await maybeRunDelegatedCommand(['extract', 'unknown-cmd'], makeDeps());
      expect(result).toEqual({ handled: false });
    });

    it('returns handled: false when no subcommand is given', async () => {
      const result = await maybeRunDelegatedCommand(['extract'], makeDeps());
      expect(result).toEqual({ handled: false });
    });
  });

  describe('mcp delegation', () => {
    it('delegates recognized mcp subcommands to the extractor CLI', async () => {
      const deps = makeDeps(0);
      const result = await maybeRunDelegatedCommand(
        ['mcp', 'discover', '--integration', 'x'],
        deps
      );

      expect(result).toEqual({ handled: true, exitCode: 0 });
      expect(deps.spawn).toHaveBeenCalledWith(
        'extract-cli',
        ['mcp', 'discover', '--integration', 'x'],
        expect.objectContaining({ stdio: 'inherit' })
      );
    });

    it('normalizes delegated signal exits to 128 plus signal number', async () => {
      const child = createMockChild();
      const spawn = vi.fn().mockReturnValue(child) as Mock;
      const resultPromise = maybeRunDelegatedCommand(['mcp', 'discover'], {
        metaUrl: 'file:///dogsled/tests/mock.ts',
        spawn,
      });

      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
      child.emit('close', null, 'SIGTERM');

      await expect(resultPromise).resolves.toEqual({ handled: true, exitCode: 143 });
    });

    it('leaves mcp serve for the Dogsled CLI direct command', async () => {
      const result = await maybeRunDelegatedCommand(['mcp', 'serve'], makeDeps());
      expect(result).toEqual({ handled: false });
    });
  });

  describe('load delegation', () => {
    it('delegates recognized subcommands', async () => {
      const deps = makeDeps(0);
      const result = await maybeRunDelegatedCommand(['load', 'run', '--format', 'csv'], deps);

      expect(result).toEqual({ handled: true, exitCode: 0 });
    });

    it('delegates bare flag arguments directly to the loader', async () => {
      const deps = makeDeps(0);
      const result = await maybeRunDelegatedCommand(
        ['load', '--format', 'csv', '--output-dir', './out'],
        deps
      );

      expect(result).toEqual({ handled: true, exitCode: 0 });
      expect(deps.spawn).toHaveBeenCalled();
    });

    it('returns handled: false when no subcommand is given', async () => {
      const result = await maybeRunDelegatedCommand(['load'], makeDeps());
      expect(result).toEqual({ handled: false });
    });
  });

  describe('embed delegation', () => {
    it('delegates recognized subcommands', async () => {
      const deps = makeDeps(0);
      const result = await maybeRunDelegatedCommand(['embed', 'run', '--config-json', '{}'], deps);

      expect(result).toEqual({ handled: true, exitCode: 0 });
    });

    it('delegates bare flag arguments directly to the embedder', async () => {
      const deps = makeDeps(0);
      const result = await maybeRunDelegatedCommand(['embed', '--config-json', '{}'], deps);

      expect(result).toEqual({ handled: true, exitCode: 0 });
      expect(deps.spawn).toHaveBeenCalled();
    });
  });

  describe('model delegation', () => {
    it.each([
      'compile',
      'dry-run',
      'profile',
      'test',
      'expect',
      'lineage',
      'init',
      'validate',
      'seed',
      'models',
    ])('delegates the %s subcommand', async (subcommand) => {
      const deps = makeDeps(0);
      const result = await maybeRunDelegatedCommand(['model', subcommand], deps);
      expect(result).toEqual({ handled: true, exitCode: 0 });
    });

    it('forwards stop signals to the model run child until it exits', async () => {
      const child = createMockChild();
      Object.assign(child, { exitCode: null, signalCode: null });
      const deps = {
        metaUrl: 'file:///dogsled/tests/mock.ts',
        spawn: vi.fn().mockReturnValue(child) as Mock,
        resolveBobsledModelRunInvocation: vi.fn(() => ({ command: 'model-run', args: [] })),
      };
      const before = process.listenerCount('SIGTERM');
      const pending = maybeRunDelegatedCommand(['model', 'run'], deps);
      await new Promise((resolve) => setImmediate(resolve));
      process.emit('SIGTERM');
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      child.emit('close', 1);
      expect(await pending).toEqual({ handled: true, exitCode: 1 });
      expect(process.listenerCount('SIGTERM')).toBe(before);
    });

    it('delegates model run to the Dogsled-owned child entrypoint', async () => {
      const deps = {
        ...makeDeps(0),
        resolveBobsledModelRunInvocation: vi.fn((_metaUrl: string, args: string[]) => ({
          command: 'bobsled-model-run-cli',
          args,
        })),
      };

      const result = await maybeRunDelegatedCommand(['model', 'run', '--json'], deps);

      expect(result).toEqual({ handled: true, exitCode: 0 });
      expect(deps.resolveBobsledModelRunInvocation).toHaveBeenCalledWith(
        'file:///dogsled/tests/mock.ts',
        ['--json']
      );
      expect(deps.spawn).toHaveBeenCalledWith(
        'bobsled-model-run-cli',
        ['--json'],
        expect.objectContaining({ stdio: 'inherit' })
      );
    });

    it('does not treat option values after model run as help requests', async () => {
      const deps = {
        ...makeDeps(0),
        resolveBobsledModelRunInvocation: vi.fn((_metaUrl: string, args: string[]) => ({
          command: 'bobsled-model-run-cli',
          args,
        })),
      };

      const result = await maybeRunDelegatedCommand(
        ['model', 'run', '--integration', 'help'],
        deps
      );

      expect(result).toEqual({ handled: true, exitCode: 0 });
      expect(deps.resolveBobsledModelRunInvocation).toHaveBeenCalledWith(
        'file:///dogsled/tests/mock.ts',
        ['--integration', 'help']
      );
      expect(deps.spawn).toHaveBeenCalledWith(
        'bobsled-model-run-cli',
        ['--integration', 'help'],
        expect.objectContaining({ stdio: 'inherit' })
      );
    });

    it.each(['--help', '-h', 'help'])('delegates model run %s to Dogsled help', async (helpArg) => {
      const deps = {
        ...makeDeps(0),
        resolveBobsledModelRunInvocation: vi.fn((_metaUrl: string, args: string[]) => ({
          command: 'bobsled-model-run-cli',
          args,
        })),
      };
      const result = await maybeRunDelegatedCommand(['model', 'run', helpArg], deps);

      expect(result).toEqual({ handled: true, exitCode: 0 });
      expect(deps.spawn).toHaveBeenCalled();
    });

    it('returns handled: false for unrecognized subcommands', async () => {
      const result = await maybeRunDelegatedCommand(['model', 'unknown'], makeDeps());
      expect(result).toEqual({ handled: false });
    });
  });

  describe('entity-graph delegation', () => {
    it.each([
      'audit',
      'build',
      'forget',
      'lineage',
      'policy',
      'resolve',
      'review',
      'status',
      'survivorship',
      'truthset',
      'agent',
    ])('delegates the %s subcommand via the entity-graph CLI', async (subcommand) => {
      const deps = makeDeps(0);
      const result = await maybeRunDelegatedCommand(['entity-graph', subcommand], deps);

      expect(result).toEqual({ handled: true, exitCode: 0 });
      expect(deps.spawn).toHaveBeenCalledWith(
        'entity-graph-cli',
        [subcommand],
        expect.objectContaining({ stdio: 'inherit' })
      );
    });

    it('returns handled: false for unrecognized subcommands', async () => {
      const result = await maybeRunDelegatedCommand(['entity-graph', 'compile'], makeDeps());
      expect(result).toEqual({ handled: false });
    });

    it('returns handled: false for removed mdm command', async () => {
      const result = await maybeRunDelegatedCommand(['mdm', 'resolve'], makeDeps());
      expect(result).toEqual({ handled: false });
    });
  });

  describe('query delegation', () => {
    it('delegates query with SQL to the loader CLI', async () => {
      const deps = makeDeps(0);
      const result = await maybeRunDelegatedCommand(
        ['query', 'SELECT 1', '--db-path', 'db.duckdb'],
        deps
      );

      expect(result).toEqual({ handled: true, exitCode: 0 });
      expect(deps.spawn).toHaveBeenCalledWith(
        'load-cli',
        ['query', 'SELECT 1', '--db-path', 'db.duckdb'],
        expect.objectContaining({ stdio: 'inherit' })
      );
    });

    it.each(['--help', '-h', 'help'])('returns handled: false for query %s', async (helpArg) => {
      const result = await maybeRunDelegatedCommand(['query', helpArg], makeDeps());
      expect(result).toEqual({ handled: false });
    });

    it('returns handled: false for bare query (no args)', async () => {
      const result = await maybeRunDelegatedCommand(['query'], makeDeps());
      expect(result).toEqual({ handled: false });
    });
  });

  it('propagates non-zero exit codes from delegated commands', async () => {
    const deps = makeDeps(42);
    const result = await maybeRunDelegatedCommand(['extract', 'validate'], deps);
    expect(result).toEqual({ handled: true, exitCode: 42 });
  });
});
