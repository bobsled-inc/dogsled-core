# SFTP Host Key Pins: Compare the Key Blob, Negotiate the Pinned Type

## Problem

The first SFTP client compared host key fingerprints as strings. ssh2 passes
`hostVerifier` a hex SHA256 digest when `hostHash` is set, while OpenSSH prints
fingerprints as unpadded base64 (`SHA256:...`), so correct pins were rejected.
Converting hex to base64 fixed that comparison, but a second failure remained:
the client pinned one fingerprint yet let ssh2 negotiate any host key type.

When a server that the client had pinned by its RSA key added an Ed25519 key,
ssh2 preferred Ed25519, received the Ed25519 key, and reported a changed host
key. Nothing had changed; the client had asked for a key type it had not pinned.

## Fix

- Each pin in `connection.host_keys` names its `algorithm` and a `fingerprint`,
  a base64 `public_key`, or both.
- The client sets `algorithms.serverHostKey` to the pinned types only, in pin
  order (`ssh-rsa` expands to `rsa-sha2-512`, `rsa-sha2-256`, `ssh-rsa`).
- `hostVerifier` receives the raw key blob (no `hostHash`). It reads the key type
  from the blob and accepts only when a pin has that algorithm and either
  `sha256(blob)` in unpadded base64 equals the fingerprint or the blob equals the
  decoded public key.
- A server without any pinned type fails with `SFTP_HOST_KEY_TYPE_UNAVAILABLE`;
  a different key of a pinned type fails with `SFTP_HOST_KEY_MISMATCH`.

## Why This Matters

- A host key pin is a type plus a key. Without the type, a server that adds a
  stronger key looks exactly like an attack.
- Compare bytes, not encoded strings: hashing the blob yourself avoids hex versus
  base64 confusion entirely.
- Regression tests run a real ssh2 server on 127.0.0.1 offering Ed25519 and RSA.
