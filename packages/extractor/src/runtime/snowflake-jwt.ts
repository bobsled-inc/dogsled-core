/**
 * Snowflake JWT auth helper.
 *
 * Generates the signed JSON Web Token Snowflake expects for key-pair authentication:
 *   - Header: { alg: 'RS256', typ: 'JWT' }
 *   - Claims:
 *       sub: <ACCOUNT>.<USER>
 *       iss: <ACCOUNT>.<USER>.SHA256:<base64 SHA-256 of SPKI-DER public key>
 *       iat: now (seconds)
 *       exp: now + 1h (Snowflake caps at 1h)
 *   - Signature: RSASSA-PKCS1-v1_5 with SHA-256 over `header.payload`
 *
 * See Snowflake docs — "Key Pair Authentication & Key Pair Rotation", JWT section.
 */

import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';

export interface BuildSnowflakeJwtOptions {
  accountIdentifier: string;
  user: string;
  /** PKCS#8 PEM-encoded RSA private key. */
  privateKeyPem: string;
  /** Passphrase for the private key, if encrypted. */
  passphrase?: string;
  /** Override `iat` for deterministic testing (seconds). */
  nowSeconds?: number;
}

/** Token lifetime in seconds. Snowflake rejects anything > 1 hour. */
const DEFAULT_LIFETIME_SECONDS = 3600;

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64url');
}

function normalizeSnowflakeIdentifier(raw: string): string {
  // Snowflake JWT claims require the uppercased bare account / user name.
  return raw.toUpperCase();
}

/**
 * Strip the region / cloud suffix from an account identifier for JWT use.
 *
 * Snowflake's JWT claim (`iss` / `sub`) requires **just the account locator**:
 *   - `xtb13140.us-east-1`           → `xtb13140`
 *   - `xtb13140.us-east-1.aws`       → `xtb13140`
 *   - `xtb13140`                      → `xtb13140`
 *   - `myorg-acct1`                   → `myorg-acct1` (org-account uses hyphen, preserved)
 *
 * For account URL construction (the REST host) we keep the region because that
 * IS the hostname. So the split between URL and JWT is intentional.
 *
 * Ref: https://docs.snowflake.com/en/user-guide/key-pair-auth (JWT section)
 */
function extractAccountLocator(raw: string): string {
  const dotIndex = raw.indexOf('.');
  return dotIndex === -1 ? raw : raw.slice(0, dotIndex);
}

function computePublicKeyFingerprint(
  privateKeyObject: ReturnType<typeof createPrivateKey>
): string {
  const publicKey = createPublicKey(privateKeyObject);
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spkiDer).digest('base64');
}

export function buildSnowflakeJwt(options: BuildSnowflakeJwtOptions): string {
  const privateKey = createPrivateKey({
    key: options.privateKeyPem,
    format: 'pem',
    ...(options.passphrase ? { passphrase: options.passphrase } : {}),
  });

  const fp = computePublicKeyFingerprint(privateKey);

  const account = normalizeSnowflakeIdentifier(extractAccountLocator(options.accountIdentifier));
  const user = normalizeSnowflakeIdentifier(options.user);

  const iat = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const exp = iat + DEFAULT_LIFETIME_SECONDS;

  const header = base64UrlEncode(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64UrlEncode(
    Buffer.from(
      JSON.stringify({
        iss: `${account}.${user}.SHA256:${fp}`,
        sub: `${account}.${user}`,
        iat,
        exp,
      })
    )
  );

  const signingInput = `${header}.${payload}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey);

  return `${signingInput}.${base64UrlEncode(signature)}`;
}
