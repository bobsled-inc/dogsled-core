# SFTP Host Fingerprint Encoding: Hex vs Base64

## Problem

`packages/extractor/src/runtime/clients/sftp-file-client.ts` verified SFTP host key fingerprints by comparing the value passed to `hostVerifier` directly against the user-configured fingerprint:

```ts
hostVerifier: (hash: string) => allowedFingerprints.has(normalizeFingerprint(hash)),
```

where `normalizeFingerprint` stripped a `SHA256:` prefix. This always returned `false`, so every SFTP connection was rejected — even when the user's `host_fingerprint` was correct.

## Root Cause

The ssh2 library passes the host key fingerprint to `hostVerifier` as a **hex-encoded SHA256 digest** (e.g., `"a3b4c5d6..."`). The standard OpenSSH format — what `ssh-keyscan | ssh-keygen -lf -` produces, and what users paste into `host_fingerprint` — is **base64-encoded** (e.g., `"SHA256:+AiSM02NeNi2OAhpjMRlFg..."`). After stripping the `SHA256:` prefix, the stored value is base64; the incoming hash is hex. They represent the same digest but look completely different as strings.

The ssh2 docs do not clearly state the encoding of the `hash` parameter, so the mismatch was invisible during implementation.

## Fix

Convert the hex digest from ssh2 to base64 before comparing:

```ts
hostVerifier: (hash: string) =>
  allowedFingerprints.has(Buffer.from(hash, 'hex').toString('base64')),
```

Also simplified `normalizeFingerprint` — the second `.replace(/^sha256:/i, '')` was redundant with the first case-insensitive replace:

```ts
function normalizeFingerprint(value: string): string {
  return value.trim().replace(/^SHA256:/i, '');
}
```

## Why This Matters

- The failure mode is "can't connect" — not "security hole that silently allows bad keys". But the security property is broken in both directions: a correct fingerprint is rejected, and any accidental hex-vs-base64 collision would pass unchecked.
- Silent mismatch bugs are common wherever a library accepts or emits binary data: always check whether a callback delivers raw bytes, hex, base64, or a higher-level encoding before comparing against a user-supplied value.
- When working with ssh2's `hostVerifier`, always convert `hash` with `Buffer.from(hash, 'hex')` before encoding into whatever format you're comparing against.
