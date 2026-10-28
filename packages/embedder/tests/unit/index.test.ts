import { EXIT_VALIDATION } from '@bobsled-inc/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '../../src/index.js';

describe('runCli', () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('handles --help without calling process.exit()', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(runCli(['--help'])).resolves.toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it('maps commander parse failures to the validation exit code', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(runCli(['--definitely-not-a-real-flag'])).resolves.toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(EXIT_VALIDATION);
  });
});
