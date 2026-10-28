import { describe, it, expect } from 'vitest';

import {
  applyDefaultViaOverride,
  parseResourceViaPair,
  validateResourceViaOverride,
} from '../../../src/commands/default-via.js';

import type { IntegrationSpec } from '../../../src/types/index.js';

// Minimal multi-transport spec_version: '2' source fixture. The applyDefaultViaOverride
// helper only reads `name`, `transports[].id`, and `default_transport`; the other
// transport fields (auth, base_url, etc.) are present so the fixture parses as
// a valid IntegrationSpec but the helper itself never inspects them.
function makeFixture(): IntegrationSpec {
  return {
    spec_version: '2',
    type: 'source',
    name: 'test',
    default_transport: 'graphql',
    transports: [
      {
        id: 'graphql',
        type: 'http',
        base_url: 'https://example.test',
        auth: { type: 'none' },
      },
      {
        id: 'mcp',
        type: 'mcp_http',
        url: 'https://example.test/mcp',
        auth: { type: 'none' },
      },
    ],
  } as unknown as IntegrationSpec;
}

function makeNonTransportFixture(): IntegrationSpec {
  // Warehouse / file-storage / legacy-single-transport variants of IntegrationSpec
  // do not declare a `transports` array. The helper's runtime guard should
  // short-circuit and return the original reference.
  return {
    spec_version: '2',
    type: 'source',
    source_type: 'postgres',
    name: 'pg',
  } as unknown as IntegrationSpec;
}

describe('applyDefaultViaOverride', () => {
  it('returns a spec with default_transport overridden when via matches a transport id', () => {
    const spec = makeFixture();
    const updated = applyDefaultViaOverride(spec, 'mcp');
    expect((updated as { default_transport: string }).default_transport).toBe('mcp');
    // Original spec is unchanged (helper does not mutate).
    expect((spec as { default_transport: string }).default_transport).toBe('graphql');
  });

  it('returns the original spec reference when via is undefined', () => {
    const spec = makeFixture();
    const updated = applyDefaultViaOverride(spec, undefined);
    expect(updated).toBe(spec);
  });

  it('throws CommandError when via does not match any transport id', () => {
    const spec = makeFixture();
    expect(() => applyDefaultViaOverride(spec, 'bogus')).toThrowError(
      /transport "bogus" not found on source "test".*Available: graphql, mcp/
    );
  });

  it('returns the original spec reference when the spec has no transports array (warehouse / legacy variant)', () => {
    const spec = makeNonTransportFixture();
    const updated = applyDefaultViaOverride(spec, 'mcp');
    // Helper short-circuits via runtime guard: warehouse / file-storage / legacy
    // single-transport API variants have no `transports`, so the override is a
    // no-op and the helper returns the original reference (no allocation).
    expect(updated).toBe(spec);
  });
});

describe('parseResourceViaPair', () => {
  it('splits a well-formed pair into { resource, via }', () => {
    expect(parseResourceViaPair('teams_mcp:graphql')).toEqual({
      resource: 'teams_mcp',
      via: 'graphql',
    });
  });

  it('handles via values that contain extra colons by using only the first separator', () => {
    expect(parseResourceViaPair('a:b:c')).toEqual({ resource: 'a', via: 'b:c' });
  });

  it('throws CommandError when the separator is missing', () => {
    expect(() => parseResourceViaPair('no_separator')).toThrowError(/expected "<resource>:<via>"/);
  });

  it('throws CommandError on empty resource', () => {
    expect(() => parseResourceViaPair(':graphql')).toThrowError(/expected "<resource>:<via>"/);
  });

  it('throws CommandError on empty via', () => {
    expect(() => parseResourceViaPair('teams_mcp:')).toThrowError(/expected "<resource>:<via>"/);
  });
});

describe('collectResourceVia (Commander accumulator)', () => {
  // We can't import collectResourceVia directly (it's internal to extract.ts),
  // but the contract is: each call layers a parsed pair onto the accumulator,
  // last write wins. Reproduce here so the contract is testable in isolation.
  function collectResourceVia(
    value: string,
    previous: Record<string, string>
  ): Record<string, string> {
    const { resource, via } = parseResourceViaPair(value);
    return { ...previous, [resource]: via };
  }

  it('accumulates multiple --resource-via pairs into a single map', () => {
    const acc1 = collectResourceVia('teams_mcp:graphql', {});
    const acc2 = collectResourceVia('cycles_mcp:graphql', acc1);
    expect(acc2).toEqual({
      teams_mcp: 'graphql',
      cycles_mcp: 'graphql',
    });
  });

  it('last write wins when the same resource appears twice', () => {
    const acc1 = collectResourceVia('teams_mcp:graphql', {});
    const acc2 = collectResourceVia('teams_mcp:mcp', acc1);
    expect(acc2).toEqual({ teams_mcp: 'mcp' });
  });
});

describe('validateResourceViaOverride', () => {
  it('returns void on valid entries', () => {
    const spec = makeFixture();
    const viaMap = { teams_mcp: 'graphql', cycles_mcp: 'graphql' };
    expect(validateResourceViaOverride(spec, viaMap)).toBeUndefined();
  });

  it('throws CommandError when any entry references an unknown transport', () => {
    const spec = makeFixture();
    expect(() => validateResourceViaOverride(spec, { teams_mcp: 'bogus' })).toThrowError(
      /transport "bogus" not found on source "test".*Available: graphql, mcp/
    );
  });

  it('passes through when the map is undefined or empty', () => {
    const spec = makeFixture();
    expect(validateResourceViaOverride(spec, undefined)).toBeUndefined();
    expect(validateResourceViaOverride(spec, {})).toBeUndefined();
  });

  it('short-circuits for specs without a transports array', () => {
    const spec = makeNonTransportFixture();
    expect(validateResourceViaOverride(spec, { something: 'mcp' })).toBeUndefined();
  });
});
