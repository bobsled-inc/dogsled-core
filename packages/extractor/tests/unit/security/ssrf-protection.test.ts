import { afterAll, afterEach, beforeAll, describe, it, expect, vi } from 'vitest';

import {
  isPrivateHost,
  isSameOrigin,
  withPrivateHostAllowlist,
} from '../../../src/framework/core/shared.js';
import {
  connectToValidatedHost,
  resetDnsLookupForTests,
  safeFetch,
  setDnsLookupForTests,
} from '../../../src/framework/core/ssrf.js';

describe('SSRF Protection', () => {
  // The test setup sets BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS=1 which disables private host checks.
  // We need to unset it for these security tests.
  let originalValue: string | undefined;

  beforeAll(() => {
    originalValue = process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'];
    delete process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'];
  });

  afterAll(() => {
    if (originalValue !== undefined) {
      process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'] = originalValue;
    } else {
      delete process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'];
    }
  });

  afterEach(() => {
    resetDnsLookupForTests();
    vi.restoreAllMocks();
  });

  describe('isPrivateHost()', () => {
    it('blocks loopback addresses', () => {
      expect(isPrivateHost('127.0.0.1')).toBe(true);
      expect(isPrivateHost('127.0.0.2')).toBe(true);
      expect(isPrivateHost('127.255.255.255')).toBe(true);
      expect(isPrivateHost('localhost')).toBe(true);
      expect(isPrivateHost('[::1]')).toBe(true);
      expect(isPrivateHost('::1')).toBe(true);
      expect(isPrivateHost('[::]')).toBe(true);
      expect(isPrivateHost('::')).toBe(true);
    });

    it('blocks private IPv4 ranges (10.x.x.x)', () => {
      expect(isPrivateHost('10.0.0.1')).toBe(true);
      expect(isPrivateHost('10.255.255.255')).toBe(true);
    });

    it('blocks private IPv4 ranges (172.16-31.x.x)', () => {
      expect(isPrivateHost('172.16.0.1')).toBe(true);
      expect(isPrivateHost('172.31.255.255')).toBe(true);
    });

    it('blocks private IPv4 ranges (192.168.x.x)', () => {
      expect(isPrivateHost('192.168.0.1')).toBe(true);
      expect(isPrivateHost('192.168.255.255')).toBe(true);
    });

    it('blocks link-local addresses (169.254.x.x)', () => {
      expect(isPrivateHost('169.254.1.1')).toBe(true);
    });

    it('blocks cloud metadata endpoints', () => {
      expect(isPrivateHost('169.254.169.254')).toBe(true);
      expect(isPrivateHost('metadata.google.internal')).toBe(true);
    });

    it('blocks IPv6 unique local (fc00::/7)', () => {
      expect(isPrivateHost('fc00::1')).toBe(true);
      expect(isPrivateHost('fd12::1')).toBe(true);
    });

    it('blocks IPv6 link-local (fe80::/10)', () => {
      expect(isPrivateHost('fe80::1')).toBe(true);
      expect(isPrivateHost('fe90::1')).toBe(true);
      expect(isPrivateHost('fea0::1')).toBe(true);
      expect(isPrivateHost('febf::1')).toBe(true);
    });

    it('blocks IPv4-mapped IPv6', () => {
      expect(isPrivateHost('::ffff:10.0.0.1')).toBe(true);
    });

    it('blocks non-public and reserved address ranges', () => {
      expect(isPrivateHost('100.64.0.1')).toBe(true);
      expect(isPrivateHost('198.18.0.1')).toBe(true);
      expect(isPrivateHost('192.0.2.1')).toBe(true);
      expect(isPrivateHost('224.0.0.1')).toBe(true);
      expect(isPrivateHost('2001:db8::1')).toBe(true);
    });

    it('allows public IP addresses', () => {
      expect(isPrivateHost('8.8.8.8')).toBe(false);
      expect(isPrivateHost('1.1.1.1')).toBe(false);
      expect(isPrivateHost('93.184.216.34')).toBe(false);
    });

    it('allows public hostnames', () => {
      expect(isPrivateHost('api.example.com')).toBe(false);
      expect(isPrivateHost('github.com')).toBe(false);
      expect(isPrivateHost('fd.example.com')).toBe(false);
      expect(isPrivateHost('fc.example.com')).toBe(false);
      expect(isPrivateHost('fe80.example.com')).toBe(false);
    });

    it('does not block non-private 172.x ranges', () => {
      expect(isPrivateHost('172.32.0.1')).toBe(false);
      expect(isPrivateHost('172.15.0.1')).toBe(false);
    });

    it('normalizes bracketed and trailing-dot hostnames', () => {
      expect(isPrivateHost('[::1]')).toBe(true);
      expect(isPrivateHost('LOCALHOST.')).toBe(true);
      expect(isPrivateHost('api.example.com.')).toBe(false);
    });

    it('ignores the retired private-host opt-in name', () => {
      const original = process.env['BOBSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS'];
      process.env['BOBSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS'] = '1';
      try {
        expect(isPrivateHost('127.0.0.1')).toBe(true);
        expect(isPrivateHost('169.254.169.254')).toBe(true);
      } finally {
        if (original === undefined) delete process.env['BOBSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS'];
        else process.env['BOBSLED_EXTRACTOR_ALLOW_PRIVATE_HOSTS'] = original;
      }
    });

    it('never allows cloud metadata or link-local addresses through the legacy opt-in', () => {
      process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'] = '1';
      try {
        expect(isPrivateHost('169.254.169.254')).toBe(true);
        expect(isPrivateHost('metadata.google.internal')).toBe(true);
        expect(isPrivateHost('fe90::1')).toBe(true);
        expect(isPrivateHost('100.100.100.200')).toBe(true);
        expect(isPrivateHost('fd00:ec2::254')).toBe(true);
        expect(isPrivateHost('127.0.0.1')).toBe(false);
      } finally {
        delete process.env['BOBSLED_CORE_EXTRACTOR_ALLOW_PRIVATE_HOSTS'];
      }
    });

    it('scopes exact mock-server allowances without leaking to concurrent work', async () => {
      let releaseAllowed!: () => void;
      const allowedPaused = new Promise<void>((resolve) => {
        releaseAllowed = resolve;
      });

      const allowedOperation = withPrivateHostAllowlist(['127.0.0.1'], async () => {
        expect(isPrivateHost('127.0.0.1')).toBe(false);
        expect(isPrivateHost('127.0.0.2')).toBe(true);
        expect(isPrivateHost('169.254.169.254')).toBe(true);
        await allowedPaused;
        expect(isPrivateHost('127.0.0.1')).toBe(false);
      });

      expect(isPrivateHost('127.0.0.1')).toBe(true);
      releaseAllowed();
      await allowedOperation;
      expect(isPrivateHost('127.0.0.1')).toBe(true);
    });
  });

  describe('safeFetch()', () => {
    it('validates the DNS answer used by the actual socket connection', async () => {
      const lookup = vi.fn().mockResolvedValue({ address: '127.0.0.2', family: 4 });
      setDnsLookupForTests(lookup);

      let error: unknown;
      try {
        await safeFetch('https://dns-rebind.example.test/resource');
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(Error);
      const messages: string[] = [];
      let current: unknown = error;
      while (current instanceof Error) {
        messages.push(current.message);
        current = current.cause;
      }
      expect(messages.join(' | ')).toContain('resolves to private address 127.0.0.2');
      expect(lookup).toHaveBeenCalledWith('dns-rebind.example.test');
    });

    it('rejects non-HTTP protocols before dispatch', async () => {
      await expect(safeFetch('file:///etc/passwd')).rejects.toThrow('must use HTTP or HTTPS');
    });
  });

  describe('connectToValidatedHost()', () => {
    it('rejects a private DNS answer before opening an SFTP-style socket', async () => {
      const lookup = vi.fn().mockResolvedValue({ address: '10.0.0.8', family: 4 });
      setDnsLookupForTests(lookup);

      await expect(connectToValidatedHost('sftp-rebind.example.test', 22)).rejects.toThrow(
        'resolves to private address 10.0.0.8'
      );
      expect(lookup).toHaveBeenCalledWith('sftp-rebind.example.test');
    });
  });

  describe('isSameOrigin()', () => {
    it('matches same origin URLs', () => {
      expect(isSameOrigin('https://api.example.com/path', 'https://api.example.com/other')).toBe(
        true
      );
    });

    it('rejects different schemes', () => {
      expect(isSameOrigin('https://api.example.com', 'http://api.example.com')).toBe(false);
    });

    it('rejects different hosts', () => {
      expect(isSameOrigin('https://api.example.com', 'https://evil.com')).toBe(false);
    });

    it('rejects different ports', () => {
      expect(isSameOrigin('https://api.example.com:443', 'https://api.example.com:8080')).toBe(
        false
      );
    });

    it('handles invalid URLs gracefully', () => {
      expect(isSameOrigin('not-a-url', 'https://example.com')).toBe(false);
    });
  });
});
