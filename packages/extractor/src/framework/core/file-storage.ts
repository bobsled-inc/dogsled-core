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

export const SftpFileStorageConnectionSchema = z
  .object({
    host: EnvStringSchema,
    port: z.number().int().positive().max(65535).default(22).optional(),
    username: EnvStringSchema,
    base_directory: z.string().min(1),
  })
  .strict();

export const SftpFileStorageAuthSchema = z
  .union([
    z
      .object({
        type: z.literal('password'),
        password_env: EnvVarNameSchema,
        host_fingerprint: z.string().min(1).optional(),
        known_hosts_path: z.string().min(1).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal('private_key'),
        private_key_path_env: EnvVarNameSchema,
        passphrase_env: EnvVarNameSchema.optional(),
        host_fingerprint: z.string().min(1).optional(),
        known_hosts_path: z.string().min(1).optional(),
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    if (!value.host_fingerprint && !value.known_hosts_path) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'SFTP auth requires host_fingerprint or known_hosts_path for host key verification',
        path: ['host_fingerprint'],
      });
    }
  });

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
  maxFiles?: number;
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

export interface DownloadFileOptions {
  signal?: AbortSignal;
}
