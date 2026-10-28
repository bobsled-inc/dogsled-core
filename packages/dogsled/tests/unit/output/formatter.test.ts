import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { success, error, info, debug, table } from '../../../src/lib/output/formatter';

import type { OutputOptions } from '../../../src/types/index';

// ---------------------------------------------------------------------------
// Mocks for stdout / stderr
// ---------------------------------------------------------------------------

let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOptions(overrides: Partial<OutputOptions> = {}): OutputOptions {
  return {
    json: false,
    quiet: false,
    verbose: false,
    noColor: true, // disable colour codes so output is predictable
    ...overrides,
  };
}

/** Returns everything written to process.stdout.write, concatenated. */
function stdoutOutput(): string {
  return stdoutSpy.mock.calls.map((call) => String(call[0])).join('');
}

/** Returns everything written to process.stderr.write, concatenated. */
function stderrOutput(): string {
  return stderrSpy.mock.calls.map((call) => String(call[0])).join('');
}

// ---------------------------------------------------------------------------
// success()
// ---------------------------------------------------------------------------

describe('success', () => {
  it('writes JSON to stdout in json mode', () => {
    success('Operation completed', makeOptions({ json: true }));

    const out = stdoutOutput();
    const parsed = JSON.parse(out.trim());
    expect(parsed).toEqual({ ok: true, message: 'Operation completed' });
  });

  it('writes text to stdout in text mode', () => {
    success('Operation completed', makeOptions());

    const out = stdoutOutput();
    expect(out).toContain('Operation completed');
    expect(out).toContain('\n');
  });

  it('does not write to stderr in either mode', () => {
    success('msg', makeOptions());
    success('msg', makeOptions({ json: true }));

    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// error()
// ---------------------------------------------------------------------------

describe('error', () => {
  it('writes JSON to stdout in json mode', () => {
    error('Something failed', makeOptions({ json: true }));

    const out = stdoutOutput();
    const parsed = JSON.parse(out.trim());
    expect(parsed).toEqual({ ok: false, error: 'Something failed' });
  });

  it('writes to stderr in text mode', () => {
    error('Something failed', makeOptions());

    const out = stderrOutput();
    expect(out).toContain('Something failed');
    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// info()
// ---------------------------------------------------------------------------

describe('info', () => {
  it('writes to stdout in text mode', () => {
    info('Informational message', makeOptions());

    const out = stdoutOutput();
    expect(out).toContain('Informational message');
  });

  it('suppressed in quiet mode', () => {
    info('Should not appear', makeOptions({ quiet: true }));

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('writes JSON to stdout in json mode', () => {
    info('Info msg', makeOptions({ json: true }));

    const out = stdoutOutput();
    const parsed = JSON.parse(out.trim());
    expect(parsed).toEqual({ level: 'info', message: 'Info msg' });
  });

  it('suppressed in quiet + json mode', () => {
    info('Should not appear', makeOptions({ quiet: true, json: true }));

    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// debug()
// ---------------------------------------------------------------------------

describe('debug', () => {
  it('only shows in verbose mode', () => {
    debug('Debug detail', makeOptions({ verbose: true }));

    // debug text mode writes to stderr
    const out = stderrOutput();
    expect(out).toContain('Debug detail');
  });

  it('suppressed when not verbose', () => {
    debug('Should not appear', makeOptions({ verbose: false }));

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('writes JSON to stdout in verbose + json mode', () => {
    debug('Debug msg', makeOptions({ verbose: true, json: true }));

    const out = stdoutOutput();
    const parsed = JSON.parse(out.trim());
    expect(parsed).toEqual({ level: 'debug', message: 'Debug msg' });
  });
});

// ---------------------------------------------------------------------------
// table()
// ---------------------------------------------------------------------------

describe('table', () => {
  const headers = ['Name', 'Status', 'Count'];
  const rows = [
    ['users', 'active', '42'],
    ['orders', 'inactive', '7'],
  ];

  it('outputs array of objects in json mode', () => {
    table(headers, rows, makeOptions({ json: true }));

    const out = stdoutOutput();
    const parsed = JSON.parse(out.trim());
    expect(parsed).toEqual([
      { Name: 'users', Status: 'active', Count: '42' },
      { Name: 'orders', Status: 'inactive', Count: '7' },
    ]);
  });

  it('outputs formatted text in text mode', () => {
    table(headers, rows, makeOptions());

    const out = stdoutOutput();
    // Should contain headers
    expect(out).toContain('Name');
    expect(out).toContain('Status');
    expect(out).toContain('Count');
    // Should contain data
    expect(out).toContain('users');
    expect(out).toContain('orders');
    // Should have multiple lines (header + separator + 2 data rows)
    const lines = out.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(4);
  });

  it('handles rows with missing cells gracefully', () => {
    const shortRows = [['users']]; // Only 1 of 3 columns

    table(headers, shortRows, makeOptions({ json: true }));

    const out = stdoutOutput();
    const parsed = JSON.parse(out.trim());
    expect(parsed).toEqual([{ Name: 'users', Status: '', Count: '' }]);
  });

  it('handles empty rows array', () => {
    table(headers, [], makeOptions({ json: true }));

    const out = stdoutOutput();
    const parsed = JSON.parse(out.trim());
    expect(parsed).toEqual([]);
  });
});
