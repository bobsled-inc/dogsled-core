import { describe, expect, it } from 'vitest';

import {
  SftpFileStorageAuthSchema,
  SftpFileStorageConnectionSchema,
} from '../../src/framework/core/index.js';
import { generateTestKey } from './sftp-test-server.js';

const ed25519 = generateTestKey('ed25519');
const ecdsa = generateTestKey('ecdsa');
const base = { host: 'sftp.example.com', username: 'agent', base_directory: '/exports' };

function parse(hostKeys: unknown, extra: Record<string, unknown> = {}) {
  return SftpFileStorageConnectionSchema.safeParse({ ...base, host_keys: hostKeys, ...extra });
}

describe('SFTP connection schema', () => {
  it('accepts fingerprint, public key, or both when they agree', () => {
    expect(parse([{ algorithm: 'ssh-ed25519', fingerprint: ed25519.fingerprint }]).success).toBe(
      true
    );
    expect(
      parse([{ algorithm: 'ssh-ed25519', fingerprint: `${ed25519.fingerprint}=` }]).success
    ).toBe(true);
    expect(parse([{ algorithm: 'ssh-ed25519', public_key: ed25519.publicKey }]).success).toBe(true);
    expect(
      parse([
        {
          algorithm: 'ssh-ed25519',
          public_key: ed25519.publicKey,
          fingerprint: ed25519.fingerprint,
        },
        { algorithm: 'ecdsa-sha2-nistp256', public_key: ecdsa.publicKey },
      ]).success
    ).toBe(true);
  });

  it('defaults read_concurrency to 4 and bounds it to 1..16', () => {
    const pins = [{ algorithm: 'ssh-ed25519', fingerprint: ed25519.fingerprint }];
    const parsed = parse(pins);
    expect(parsed.success && parsed.data.read_concurrency).toBe(4);
    expect(parse(pins, { read_concurrency: 16 }).success).toBe(true);
    expect(parse(pins, { read_concurrency: 0 }).success).toBe(false);
    expect(parse(pins, { read_concurrency: 17 }).success).toBe(false);
  });

  it.each([
    ['missing host_keys', undefined],
    ['empty host_keys', []],
    [
      'more than four pins',
      Array.from({ length: 5 }, () => ({
        algorithm: 'ssh-ed25519',
        fingerprint: ed25519.fingerprint,
      })),
    ],
    ['no fingerprint or public key', [{ algorithm: 'ssh-ed25519' }]],
    ['missing algorithm', [{ fingerprint: ed25519.fingerprint }]],
    ['unsupported algorithm', [{ algorithm: 'ssh-dss', fingerprint: ed25519.fingerprint }]],
    ['hex fingerprint', [{ algorithm: 'ssh-ed25519', fingerprint: 'a3'.repeat(32) }]],
    [
      'lowercase prefix',
      [{ algorithm: 'ssh-ed25519', fingerprint: ed25519.fingerprint.replace('SHA256', 'sha256') }],
    ],
    ['public key of another type', [{ algorithm: 'ssh-rsa', public_key: ed25519.publicKey }]],
    ['garbage public key', [{ algorithm: 'ssh-ed25519', public_key: 'not-base64!' }]],
    ['public key not an SSH blob', [{ algorithm: 'ssh-ed25519', public_key: 'AAAA' }]],
    [
      'fingerprint disagreeing with public key',
      [{ algorithm: 'ssh-ed25519', public_key: ed25519.publicKey, fingerprint: ecdsa.fingerprint }],
    ],
    [
      'duplicate key',
      [
        { algorithm: 'ssh-ed25519', fingerprint: ed25519.fingerprint },
        { algorithm: 'ssh-ed25519', public_key: ed25519.publicKey },
      ],
    ],
    [
      'unknown pin field',
      [{ algorithm: 'ssh-ed25519', fingerprint: ed25519.fingerprint, comment: 'x' }],
    ],
  ])('rejects %s', (_label, hostKeys) => {
    const result = parse(hostKeys);
    expect(result.success).toBe(false);
    // The rejection must come from the pin itself, not from an unrelated schema error.
    const paths = result.error?.issues.map((issue) => issue.path[0]) ?? [];
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((key) => key === 'host_keys')).toBe(true);
  });
});

describe('SFTP auth schema', () => {
  it('no longer accepts host key settings on auth', () => {
    expect(
      SftpFileStorageAuthSchema.safeParse({
        type: 'password',
        password_env: 'SFTP_PASSWORD',
        host_fingerprint: ed25519.fingerprint,
      }).success
    ).toBe(false);
    expect(
      SftpFileStorageAuthSchema.safeParse({ type: 'password', password_env: 'SFTP_PASSWORD' })
        .success
    ).toBe(true);
    expect(
      SftpFileStorageAuthSchema.safeParse({
        type: 'private_key',
        private_key_path_env: 'SFTP_KEY_PATH',
        passphrase_env: 'SFTP_KEY_PASSPHRASE',
      }).success
    ).toBe(true);
  });
});
