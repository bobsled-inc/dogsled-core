import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION, type ProgressMessage } from '@bobsled-inc/protocol';

import { summarizeHealthCheck } from './command-insights';
import type { CommandOutput } from './use-command';

function createProgressOutput(message: ProgressMessage): CommandOutput {
  return {
    id: 1,
    timestamp: Date.now(),
    stream: 'stderr',
    raw: JSON.stringify(message),
    parsed: message,
  };
}

describe('summarizeHealthCheck', () => {
  it('treats explicit health-check progress failures as authoritative', () => {
    const message: ProgressMessage = {
      _v: PROTOCOL_VERSION,
      type: 'PROGRESS',
      event: 'health_check_complete',
      timestamp: new Date().toISOString(),
      data: {
        status: 'failed',
        error: 'Token expired',
      },
    };

    expect(summarizeHealthCheck([createProgressOutput(message)], 0, null)).toEqual({
      status: 'failed',
      missingVars: [],
      error: 'Token expired',
    });
  });
});
