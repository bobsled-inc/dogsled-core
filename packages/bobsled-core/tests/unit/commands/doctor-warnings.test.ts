import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { expect, it, vi } from 'vitest';
vi.mock('../../../src/runner/commands/validation.js', () => ({
  validateCliProjectPipelines: vi.fn().mockResolvedValue({
    valid: true,
    errors: [],
    warnings: ['BOBSLED_CORE_LEGACY_BLUEPRINT_KEY: legacy_field is deprecated'],
    project: { config: {} },
  }),
}));
import * as fmt from '../../../src/lib/output/formatter.js';
import { registerDoctorCommand } from '../../../src/commands/doctor.js';
it('preserves validation warnings in doctor JSON without failing a valid project', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bobsled-doctor-warnings-'));
  const output = vi.spyOn(fmt, 'output').mockImplementation(() => {});
  const previous = process.exitCode;
  try {
    const program = new Command();
    registerDoctorCommand(program);
    await program.parseAsync(['node', 'bobsled', 'doctor', '--project-root', root, '--json']);
    expect(output).toHaveBeenCalledWith(
      expect.objectContaining({
        valid: true,
        checks: expect.arrayContaining([
          expect.objectContaining({
            status: 'warn',
            message: 'BOBSLED_CORE_LEGACY_BLUEPRINT_KEY: legacy_field is deprecated',
          }),
        ]),
      }),
      expect.anything()
    );
    expect(process.exitCode).toBe(0);
  } finally {
    output.mockRestore();
    process.exitCode = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
