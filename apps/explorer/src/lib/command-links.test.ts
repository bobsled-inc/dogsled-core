import { describe, expect, it } from 'vitest';

import {
  formatExplorerCommandForHistory,
  getDuckDbPathFromExplorerCommand,
  getIntegrationFromCommand,
} from './command-links.js';

describe('getIntegrationFromCommand', () => {
  it('prefers explicit integration flags for pipeline runs', () => {
    expect(
      getIntegrationFromCommand('pipeline', [
        '--integration',
        'shopify',
        '--db-path',
        '/tmp/dev.duckdb',
      ])
    ).toBe('shopify');
  });

  it('skips option values when deriving extract integrations', () => {
    expect(getIntegrationFromCommand('extract', ['--profile', 'dev', 'run', 'stripe'])).toBe(
      'stripe'
    );
  });

  it('skips option values before integrations show subcommands', () => {
    expect(getIntegrationFromCommand('integrations', ['--type', 'api', 'show', 'slack'])).toBe(
      'slack'
    );
  });
});

describe('formatExplorerCommandForHistory / getDuckDbPathFromExplorerCommand', () => {
  it('summarizes command sequences for history and data links', () => {
    const sequence = {
      sequence: [
        {
          command: 'pipeline',
          args: ['--integration', 'stripe', '--db-path', './pipeline.duckdb'],
        },
        {
          command: 'pipeline',
          args: ['--integration', 'hubspot', '--db-path', './pipeline.duckdb'],
        },
      ],
    };

    expect(formatExplorerCommandForHistory(sequence)).toEqual({
      command: 'pipeline-batch',
      args: ['stripe', 'hubspot'],
    });
    expect(getDuckDbPathFromExplorerCommand(sequence)).toBe('./pipeline.duckdb');
  });
});
