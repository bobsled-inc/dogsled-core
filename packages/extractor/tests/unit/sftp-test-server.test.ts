import ssh2 from 'ssh2';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateTestKey } from './sftp-test-server.js';

afterEach(() => vi.restoreAllMocks());

describe('SFTP test key generation', () => {
  it.each(['ed25519', 'rsa', 'ecdsa'] as const)('generates parseable %s keys', (type) => {
    const key = generateTestKey(type);
    const parsed = ssh2.utils.parseKey(key.privateKey);
    expect(parsed).not.toBeInstanceOf(Error);
    if (parsed instanceof Error) throw parsed;
    expect(parsed.getPublicSSH().toString('base64')).toBe(key.publicKey);
  });

  it('replaces a malformed generated key before returning a fixture', () => {
    const valid = generateTestKey('ed25519');
    const generate = vi
      .spyOn(ssh2.utils, 'generateKeyPairSync')
      .mockReturnValue({
        private: valid.privateKey,
        public: `${valid.algorithm} ${valid.publicKey}`,
      })
      .mockReturnValueOnce({ private: 'invalid-generated-key', public: '' });
    const key = generateTestKey('ed25519');
    expect(generate).toHaveBeenCalledTimes(2);
    expect(key.publicKey).toBe(valid.publicKey);
    expect(ssh2.utils.parseKey(key.privateKey)).not.toBeInstanceOf(Error);
  });

  it('fails after a bounded number of malformed results', () => {
    const generate = vi.spyOn(ssh2.utils, 'generateKeyPairSync').mockReturnValue({
      private: 'invalid-generated-key',
      public: '',
    });
    expect(() => generateTestKey('ed25519')).toThrow(
      'Unable to generate a parseable SFTP test key after 8 attempts'
    );
    expect(generate).toHaveBeenCalledTimes(8);
  });
});
