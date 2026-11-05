import { afterEach, describe, expect, it, vi } from 'vitest';
import { InterpolationError, interpolateValue } from '../src/api-request-interpolation.js';
afterEach(() => vi.unstubAllEnvs());
describe('environment interpolation boundary', () => {
  it.each(['AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'OPENAI_API_KEY'])(
    'blocks %s on every env path',
    (key) => {
      vi.stubEnv(key, 'synthetic-value');
      for (const context of [
        {},
        { env: process.env },
        { env: { [key]: 'synthetic-value' } },
        { env: { ...process.env } },
      ]) {
        expect(() =>
          interpolateValue('${{ env.' + key + ' }}', {
            ...context,
            declaredEnvVars: new Set([key]),
          })
        ).toThrow();
      }
    }
  );
  it('blocks the ambient secrets namespace for reserved keys', () => {
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'synthetic-value');
    expect(() =>
      interpolateValue('${{ secrets.AWS_SECRET_ACCESS_KEY }}', { secrets: process.env })
    ).toThrow();
  });
  it('preserves explicit secrets and permitted env values', () => {
    expect(
      interpolateValue('${{ env.SERVICE_TOKEN }}', {
        env: { SERVICE_TOKEN: 'synthetic' },
        declaredEnvVars: new Set(['SERVICE_TOKEN']),
      })
    ).toBe('synthetic');
    expect(
      interpolateValue('${{ secrets.SERVICE_TOKEN }}', {
        secrets: { SERVICE_TOKEN: 'synthetic' },
        declaredEnvVars: new Set(['SERVICE_TOKEN']),
      })
    ).toBe('synthetic');
  });
});

describe('declared environment names', () => {
  it.each(['env', 'secrets'])(
    'rejects undeclared %s names from any map without reading values',
    (source) => {
      const readSecret = vi.fn(() => 'must-not-appear');
      const values = Object.defineProperty({}, 'SNOWFLAKE_PASSWORD', {
        enumerable: true,
        get: readSecret,
      });
      expect(() =>
        interpolateValue('${{ ' + source + '.SNOWFLAKE_PASSWORD }}', { [source]: values })
      ).toThrow(
        'Undeclared environment variable: SNOWFLAKE_PASSWORD. Add SNOWFLAKE_PASSWORD to auth_env_vars.'
      );
      expect(readSecret).not.toHaveBeenCalled();
    }
  );
  it.each(['env', 'secrets'])(
    'keeps the denylist for declared %s names in copied maps',
    (source) => {
      expect(() =>
        interpolateValue('${{ ' + source + '.GITHUB_TOKEN }}', {
          [source]: { GITHUB_TOKEN: 'synthetic' },
          declaredEnvVars: new Set(['GITHUB_TOKEN']),
        })
      ).toThrow();
    }
  );
});

describe('host secret declarations', () => {
  it('permits declared host secrets without granting environment access', () => {
    const context = {
      secrets: { HOST_TOKEN: 'host-value' },
      env: { HOST_TOKEN: 'env-value' },
      declaredSecretNames: ['HOST_TOKEN'],
    };
    expect(interpolateValue('${{ secrets.HOST_TOKEN }}', context)).toBe('host-value');
    expect(() =>
      interpolateValue('${{ secrets.HOST_TOKEN }}', { secrets: context.secrets })
    ).toThrow('Undeclared');
    expect(() => interpolateValue('${{ env.HOST_TOKEN }}', context)).toThrow('Undeclared');
    expect(() =>
      interpolateValue('${{ secrets.GITHUB_TOKEN }}', {
        secrets: { GITHUB_TOKEN: 'blocked' },
        declaredSecretNames: ['GITHUB_TOKEN'],
      })
    ).toThrow();
  });
});

describe('trusted credential names', () => {
  const trusted = new Set(['SLACK_BOT_TOKEN']);
  const declaredEnvVars = new Set(['SLACK_BOT_TOKEN', 'GITHUB_TOKEN']);

  it.each(['env', 'secrets'])('resolves a trusted reserved %s name from its map', (source) => {
    expect(
      interpolateValue('${{ ' + source + '.SLACK_BOT_TOKEN }}', {
        [source]: { SLACK_BOT_TOKEN: 'synthetic' },
        declaredEnvVars,
        trustedCredentialNames: trusted,
      })
    ).toBe('synthetic');
  });

  it('never reads a trusted reserved name through the process.env fallback', () => {
    vi.stubEnv('SLACK_BOT_TOKEN', 'ambient');
    expect(() =>
      interpolateValue('${{ env.SLACK_BOT_TOKEN }}', {
        declaredEnvVars,
        trustedCredentialNames: trusted,
      })
    ).toThrow('Missing env.SLACK_BOT_TOKEN');
  });

  it('still requires a declaration for a trusted name', () => {
    expect(() =>
      interpolateValue('${{ env.SLACK_BOT_TOKEN }}', {
        env: { SLACK_BOT_TOKEN: 'synthetic' },
        trustedCredentialNames: trusted,
      })
    ).toThrow('Undeclared');
  });

  it.each(['env', 'secrets'])('explains a blocked %s name without its value', (source) => {
    let error: unknown;
    try {
      interpolateValue(
        '${{ ' + source + '.GITHUB_TOKEN }}',
        {
          [source]: { GITHUB_TOKEN: 'must-not-appear' },
          declaredEnvVars,
          trustedCredentialNames: trusted,
        },
        'auth.token'
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(InterpolationError);
    expect(error).toMatchObject({ name: 'InterpolationError', source, key: 'GITHUB_TOKEN' });
    const { message } = error as Error;
    expect(message).toContain(`Reserved credential name ${source}.GITHUB_TOKEN`);
    expect(message).toContain('auth.token');
    expect(message).toContain('declaredEnvNames');
    expect(message).not.toContain('Missing');
    expect(message).not.toContain('must-not-appear');
  });
});
