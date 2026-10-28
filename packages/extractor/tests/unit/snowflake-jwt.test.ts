import { createPrivateKey, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { buildSnowflakeJwt } from '../../src/runtime/snowflake-jwt.js';

function generateRsaKeys(passphrase?: string): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: passphrase
      ? { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase }
      : { type: 'pkcs8', format: 'pem' },
  });
  return { privateKeyPem: privateKey as string, publicKeyPem: publicKey as string };
}

function decodeSegment(seg: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
}

describe('buildSnowflakeJwt', () => {
  it('returns a three-segment RS256 JWT', () => {
    const { privateKeyPem } = generateRsaKeys();
    const jwt = buildSnowflakeJwt({
      accountIdentifier: 'acct123',
      user: 'svc_user',
      privateKeyPem,
    });
    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);
    const header = decodeSegment(parts[0]!);
    expect(header).toMatchObject({ alg: 'RS256', typ: 'JWT' });
  });

  it('issues the Snowflake-required claims (iss, sub, iat, exp)', () => {
    const { privateKeyPem } = generateRsaKeys();
    const jwt = buildSnowflakeJwt({
      accountIdentifier: 'acct123',
      user: 'svc_user',
      privateKeyPem,
    });
    const payload = decodeSegment(jwt.split('.')[1]!);
    expect(payload.sub).toBe('ACCT123.SVC_USER');
    expect(String(payload.iss)).toMatch(/^ACCT123\.SVC_USER\.SHA256:[A-Za-z0-9+/=]+$/);
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.exp).toBe('number');
    expect((payload.exp as number) - (payload.iat as number)).toBeGreaterThan(0);
    expect((payload.exp as number) - (payload.iat as number)).toBeLessThanOrEqual(3600);
  });

  it('uppercases account identifier and user (Snowflake convention)', () => {
    const { privateKeyPem } = generateRsaKeys();
    const jwt = buildSnowflakeJwt({
      accountIdentifier: 'myAccount',
      user: 'serviceUser',
      privateKeyPem,
    });
    const payload = decodeSegment(jwt.split('.')[1]!);
    expect(payload.sub).toBe('MYACCOUNT.SERVICEUSER');
  });

  it('signs the JWT with the given private key (verifiable with matching public key)', () => {
    const { privateKeyPem, publicKeyPem } = generateRsaKeys();
    const jwt = buildSnowflakeJwt({
      accountIdentifier: 'acct',
      user: 'u',
      privateKeyPem,
    });
    const [headerB64, payloadB64, signatureB64] = jwt.split('.');
    const signedInput = Buffer.from(`${headerB64}.${payloadB64}`);
    const signature = Buffer.from(signatureB64!, 'base64url');
    const ok = verify('RSA-SHA256', signedInput, createPublicKey(publicKeyPem), signature);
    expect(ok).toBe(true);
  });

  it('accepts a passphrase-protected private key', () => {
    const { privateKeyPem } = generateRsaKeys('my-secret');
    expect(() =>
      buildSnowflakeJwt({
        accountIdentifier: 'a',
        user: 'u',
        privateKeyPem,
        passphrase: 'my-secret',
      })
    ).not.toThrow();
  });

  it('throws a clear error on wrong passphrase', () => {
    const { privateKeyPem } = generateRsaKeys('correct-pass');
    expect(() =>
      buildSnowflakeJwt({
        accountIdentifier: 'a',
        user: 'u',
        privateKeyPem,
        passphrase: 'wrong-pass',
      })
    ).toThrow();
  });

  it('derives the fingerprint (iss suffix) from the public half of the supplied private key', () => {
    const { privateKeyPem, publicKeyPem } = generateRsaKeys();
    const jwt = buildSnowflakeJwt({
      accountIdentifier: 'a',
      user: 'u',
      privateKeyPem,
    });
    const payload = decodeSegment(jwt.split('.')[1]!);
    const iss = String(payload.iss);
    const match = /SHA256:([A-Za-z0-9+/=]+)$/.exec(iss);
    expect(match).not.toBeNull();

    // Recompute the fingerprint from the public key and compare.
    const publicDer = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    const expectedFp = createHash('sha256').update(publicDer).digest('base64');
    expect(match![1]).toBe(expectedFp);
    // Also silence the unused-var lint for createPrivateKey in imports.
    void createPrivateKey;
  });

  // Regression tests for JWT "account locator" extraction.
  // Snowflake rejects the JWT if iss/sub contain region or cloud suffixes.
  describe('account identifier — strips region/cloud suffix for JWT claims', () => {
    it('uses just the locator when input is regional (xtb13140.us-east-1)', () => {
      const { privateKeyPem } = generateRsaKeys();
      const jwt = buildSnowflakeJwt({
        accountIdentifier: 'xtb13140.us-east-1',
        user: 'dbt_user',
        privateKeyPem,
      });
      const payload = decodeSegment(jwt.split('.')[1]!);
      expect(payload.sub).toBe('XTB13140.DBT_USER');
      expect(String(payload.iss)).toMatch(/^XTB13140\.DBT_USER\.SHA256:/);
    });

    it('uses just the locator when input carries cloud (xtb13140.us-east-1.aws)', () => {
      const { privateKeyPem } = generateRsaKeys();
      const jwt = buildSnowflakeJwt({
        accountIdentifier: 'xtb13140.us-east-1.aws',
        user: 'u',
        privateKeyPem,
      });
      const payload = decodeSegment(jwt.split('.')[1]!);
      expect(payload.sub).toBe('XTB13140.U');
    });

    it('preserves org-account hyphen form (myorg-acct1)', () => {
      const { privateKeyPem } = generateRsaKeys();
      const jwt = buildSnowflakeJwt({
        accountIdentifier: 'myorg-acct1',
        user: 'u',
        privateKeyPem,
      });
      const payload = decodeSegment(jwt.split('.')[1]!);
      expect(payload.sub).toBe('MYORG-ACCT1.U');
    });

    it('passes through bare locator unchanged (xtb13140)', () => {
      const { privateKeyPem } = generateRsaKeys();
      const jwt = buildSnowflakeJwt({
        accountIdentifier: 'xtb13140',
        user: 'u',
        privateKeyPem,
      });
      const payload = decodeSegment(jwt.split('.')[1]!);
      expect(payload.sub).toBe('XTB13140.U');
    });
  });
});
