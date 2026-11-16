import { expect, it, vi } from 'vitest';
const exec = vi.hoisted(() =>
  vi.fn((_file, _args, _options, done) => done(null, { stdout: '{"rows":[]}' }))
);
vi.mock('node:child_process', () => ({ execFile: exec }));
import { readWithCli } from '../../../src/runtime/onboarding/verify.js';
it('forces machine-readable subprocess output even when the caller prefers text', async () => {
  vi.stubEnv('BOBSLED_CORE_OUTPUT_FORMAT', 'text');
  try {
    expect(await readWithCli(process.cwd(), 'SELECT 1', false)).toEqual({ rows: [] });
    expect(exec.mock.calls[0]?.[2].env.BOBSLED_CORE_OUTPUT_FORMAT).toBe('json');
  } finally {
    vi.unstubAllEnvs();
  }
});
