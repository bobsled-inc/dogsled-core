import { createHash } from 'node:crypto';

import { z } from 'zod';

export const FileStorageSourceTypeValues = ['s3', 'gcs', 'sftp', 'local', 'vercel_blob'] as const;
export const FileStorageSourceTypeSchema = z.enum(FileStorageSourceTypeValues);
export type FileStorageSourceType = z.infer<typeof FileStorageSourceTypeSchema>;

const EnvStringSchema = z.string().min(1);
const EnvVarNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);

export const S3FileStorageConnectionSchema = z
  .object({
    bucket: EnvStringSchema,
    region: z.string().min(1),
    endpoint: z.string().url().optional(),
    force_path_style: z.boolean().optional(),
  })
  .strict();

export const S3FileStorageAuthSchema = z
  .union([
    z.object({ type: z.literal('default_chain') }).strict(),
    z
      .object({
        type: z.literal('static_env'),
        access_key_id_env: EnvVarNameSchema,
        secret_access_key_env: EnvVarNameSchema,
        session_token_env: EnvVarNameSchema.optional(),
      })
      .strict(),
  ])
  .describe('S3 auth. Credential fields reference environment variable names.');

export const GcsFileStorageConnectionSchema = z
  .object({
    bucket: EnvStringSchema,
    project_id: z.string().min(1).optional(),
  })
  .strict();

export const GcsFileStorageAuthSchema = z.union([
  z.object({ type: z.literal('adc') }).strict(),
  z
    .object({ type: z.literal('service_account_json'), credentials_json_env: EnvVarNameSchema })
    .strict(),
  z
    .object({ type: z.literal('service_account_path'), credentials_path_env: EnvVarNameSchema })
    .strict(),
]);

export const SFTP_HOST_KEY_ALGORITHMS = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'ssh-rsa',
] as const;
export type SftpHostKeyAlgorithm = (typeof SFTP_HOST_KEY_ALGORITHMS)[number];

/** The key type named inside an SSH public key blob (uint32 BE length + name). */
export function sshKeyBlobType(blob: Buffer): string | undefined {
  if (blob.length < 4) return undefined;
  const length = blob.readUInt32BE(0);
  if (length === 0 || length > 64 || 4 + length > blob.length) return undefined;
  return blob.subarray(4, 4 + length).toString('latin1');
}

/** OpenSSH SHA256 fingerprint body: unpadded base64 of sha256(key blob). */
export function sshKeyFingerprint(blob: Buffer): string {
  return createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
}

export function normalizeSshFingerprint(fingerprint: string): string {
  return fingerprint.replace(/^SHA256:/, '').replace(/=+$/, '');
}

const SshFingerprintSchema = z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}=?$/, {
  message: 'fingerprint must be an OpenSSH SHA256 fingerprint (SHA256:<43 base64 chars>)',
});

const SshPublicKeySchema = z
  .string()
  .max(16_384)
  .refine((value) => /^[A-Za-z0-9+/]+={0,2}$/.test(value) && decodePublicKey(value) !== undefined, {
    message: 'public_key must be the base64 key blob from an authorized_keys or known_hosts line',
  });

function decodePublicKey(value: string): Buffer | undefined {
  const blob = Buffer.from(value, 'base64');
  // Buffer decoding is lenient; require the canonical encoding of a well-formed blob.
  return blob.toString('base64') === value && sshKeyBlobType(blob) ? blob : undefined;
}

/** The fingerprint a pin identifies, from either field (schema guarantees they agree). */
export function sftpHostKeyPinFingerprint(pin: {
  fingerprint?: string;
  public_key?: string;
}): string {
  if (pin.fingerprint) return normalizeSshFingerprint(pin.fingerprint);
  return sshKeyFingerprint(Buffer.from(pin.public_key ?? '', 'base64'));
}

export const SftpHostKeyPinSchema = z
  .object({
    algorithm: z.enum(SFTP_HOST_KEY_ALGORITHMS),
    fingerprint: SshFingerprintSchema.optional(),
    public_key: SshPublicKeySchema.optional(),
  })
  .strict()
  .superRefine((pin, ctx) => {
    if (!pin.fingerprint && !pin.public_key) {
      ctx.addIssue({
        code: 'custom',
        message: 'SFTP host key pin requires fingerprint or public_key',
        path: ['fingerprint'],
      });
      return;
    }
    const blob = pin.public_key ? decodePublicKey(pin.public_key) : undefined;
    if (!blob) return;
    if (sshKeyBlobType(blob) !== pin.algorithm) {
      ctx.addIssue({
        code: 'custom',
        message: `public_key is a ${sshKeyBlobType(blob)} key, not ${pin.algorithm}`,
        path: ['public_key'],
      });
    }
    if (pin.fingerprint && normalizeSshFingerprint(pin.fingerprint) !== sshKeyFingerprint(blob)) {
      ctx.addIssue({
        code: 'custom',
        message: 'fingerprint does not match public_key',
        path: ['fingerprint'],
      });
    }
  });
export type SftpHostKeyPin = z.infer<typeof SftpHostKeyPinSchema>;

export const SftpFileStorageConnectionSchema = z
  .object({
    host: EnvStringSchema,
    port: z.number().int().positive().max(65535).default(22).optional(),
    username: EnvStringSchema,
    base_directory: z.string().min(1),
    host_keys: z
      .array(SftpHostKeyPinSchema)
      .min(1)
      .max(4)
      .superRefine((pins, ctx) => {
        const seen = new Set<string>();
        pins.forEach((pin, index) => {
          if (!pin.fingerprint && !pin.public_key) return;
          const fingerprint = sftpHostKeyPinFingerprint(pin);
          if (seen.has(fingerprint)) {
            ctx.addIssue({ code: 'custom', message: 'duplicate host key pin', path: [index] });
          }
          seen.add(fingerprint);
        });
      })
      .describe('Pinned SSH host keys in preference order. Only these key types are negotiated.'),
    read_concurrency: z
      .number()
      .int()
      .min(1)
      .max(16)
      .default(4)
      .describe('Maximum SFTP READ requests in flight on the connection.'),
  })
  .strict();
export type SftpFileStorageConnection = z.output<typeof SftpFileStorageConnectionSchema>;

export const SftpFileStorageAuthSchema = z.union([
  z.object({ type: z.literal('password'), password_env: EnvVarNameSchema }).strict(),
  z
    .object({
      type: z.literal('private_key'),
      private_key_env: EnvVarNameSchema.optional().describe(
        'Env var holding the OpenSSH private key text.'
      ),
      private_key_path_env: EnvVarNameSchema.optional().describe(
        'Env var holding the path to the OpenSSH private key file.'
      ),
      passphrase_env: EnvVarNameSchema.optional(),
    })
    .strict()
    .refine(
      (auth) => (auth.private_key_env === undefined) !== (auth.private_key_path_env === undefined),
      {
        message:
          'SFTP private_key auth needs exactly one of private_key_env or private_key_path_env',
        path: ['private_key_env'],
      }
    ),
]);
export type SftpFileStorageAuth = z.infer<typeof SftpFileStorageAuthSchema>;

export const LocalFileStorageConnectionSchema = z
  .object({
    base_directory: z.string().min(1),
  })
  .strict();

export const LocalFileStorageAuthSchema = z.object({ type: z.literal('none') }).strict();

/**
 * A private Vercel Blob source names one stable object reference.  The signed
 * URL used to read it is deliberately kept out of the integration and is
 * supplied through the auth env references below at execution time.
 */
export const VercelBlobFileStorageConnectionSchema = z
  .object({
    blob_ref: z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
        message: 'blob_ref must not contain control characters',
      })
      .refine((value) => !value.includes('?') && !value.includes('#'), {
        message: 'blob_ref must be a stable object reference, not a signed URL',
      })
      .refine((value) => !/[*\[\]{}]/.test(value), {
        message: 'blob_ref must identify one object and must not contain glob characters',
      })
      .refine(
        (value) =>
          !value.startsWith('/') &&
          !value
            .split('/')
            .some((segment) => segment === '..' || segment === '.' || segment === ''),
        {
          message: 'blob_ref must be a provider-relative pathname',
        }
      ),
    max_bytes: z.number().int().positive().max(5_368_709_120).default(262_144_000).optional(),
    max_retries: z.number().int().nonnegative().max(5).default(3).optional(),
    retry_delay_ms: z.number().int().nonnegative().max(5_000).default(250).optional(),
    timeout_ms: z.number().int().positive().max(600_000).default(120_000).optional(),
  })
  .strict();

export const VercelBlobFileStorageAuthSchema = z
  .object({
    type: z.literal('signed_url_env'),
    url_env: EnvVarNameSchema,
    origin_env: EnvVarNameSchema,
  })
  .strict()
  .describe(
    'Private Vercel Blob auth. url_env contains a fresh object-scoped signed URL and origin_env contains its allowed HTTPS origin.'
  );

export interface ListedFile {
  path: string;
  uri: string;
  last_modified?: string | Date;
  /**
   * When this version of the content was written, for a store that keeps that apart from
   * `last_modified`. GCS gives `timeCreated`; its `updated` time also moves when only metadata does.
   */
  created?: string;
  etag?: string;
  generation?: string;
  size?: number;
}

export interface DownloadedFile {
  file: ListedFile;
  path: string;
  bytes_downloaded: number;
}

export interface ListFilesOptions {
  path: string;
  /**
   * Stops the listing after this many matching files (a positive count). The extractors
   * leave it unset: their per-run limit counts the files they read, and a capped listing
   * would stop among files they have already read.
   */
  maxFiles?: number;
  signal?: AbortSignal;
}

export interface FileStorageClient {
  list(options: ListFilesOptions): AsyncGenerator<ListedFile>;
  download(
    file: ListedFile,
    targetPath: string,
    options?: DownloadFileOptions
  ): Promise<DownloadedFile>;
  close(): Promise<void>;
}

export interface ExpectedRemoteFile {
  size: number;
  mtimeSeconds: number;
}

export interface DownloadProgress {
  /** Indexes of the fixed-size read chunks already written to the target. */
  completedChunks: Set<number>;
  /** Set by the client: completed chunks only count for the same file, pin and target. */
  boundTo?: string;
}

export interface DownloadFileOptions {
  signal?: AbortSignal;
  /** GCS only: keep a gzip-encoded object's stored bytes. Without it the client decompresses them. */
  asStored?: boolean;
  /** SFTP only: fail with SFTP_FILE_CHANGED unless the remote file still has this size and mtime. */
  expected?: ExpectedRemoteFile;
  /** SFTP only, requires `expected`: pass the same object and target to resume after a retryable failure. */
  progress?: DownloadProgress;
}
