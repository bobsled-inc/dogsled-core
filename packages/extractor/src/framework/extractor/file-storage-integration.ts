import { AuthEnvVarsSchema } from '@bobsled-inc/protocol';
import { z } from 'zod';

import {
  GcsFileStorageAuthSchema,
  GcsFileStorageConnectionSchema,
  LocalFileStorageAuthSchema,
  LocalFileStorageConnectionSchema,
  S3FileStorageAuthSchema,
  S3FileStorageConnectionSchema,
  SpecNameSchema,
  SftpFileStorageAuthSchema,
  SftpFileStorageConnectionSchema,
  VercelBlobFileStorageAuthSchema,
  VercelBlobFileStorageConnectionSchema,
} from '../core/index.js';

const IntegrationSpecBase = {
  spec_version: z.literal('1'),
  type: z.literal('integration'),
  auth_env_vars: AuthEnvVarsSchema,
  name: SpecNameSchema,
  description: z.string().optional(),
} as const;

export const S3FileStorageIntegrationSpecSchema = z
  .object({
    ...IntegrationSpecBase,
    source_type: z.literal('s3'),
    connection: S3FileStorageConnectionSchema,
    auth: S3FileStorageAuthSchema,
  })
  .strict();

export const GcsFileStorageIntegrationSpecSchema = z
  .object({
    ...IntegrationSpecBase,
    source_type: z.literal('gcs'),
    connection: GcsFileStorageConnectionSchema,
    auth: GcsFileStorageAuthSchema,
  })
  .strict();

export const SftpFileStorageIntegrationSpecSchema = z
  .object({
    ...IntegrationSpecBase,
    source_type: z.literal('sftp'),
    connection: SftpFileStorageConnectionSchema,
    auth: SftpFileStorageAuthSchema,
  })
  .strict();

export const LocalFileStorageIntegrationSpecSchema = z
  .object({
    ...IntegrationSpecBase,
    source_type: z.literal('local'),
    connection: LocalFileStorageConnectionSchema,
    auth: LocalFileStorageAuthSchema,
  })
  .strict();

export const VercelBlobFileStorageIntegrationSpecSchema = z
  .object({
    ...IntegrationSpecBase,
    source_type: z.literal('vercel_blob'),
    connection: VercelBlobFileStorageConnectionSchema,
    auth: VercelBlobFileStorageAuthSchema,
  })
  .strict();

export type S3FileStorageIntegrationSpec = z.infer<typeof S3FileStorageIntegrationSpecSchema>;
export type GcsFileStorageIntegrationSpec = z.infer<typeof GcsFileStorageIntegrationSpecSchema>;
export type SftpFileStorageIntegrationSpec = z.infer<typeof SftpFileStorageIntegrationSpecSchema>;
export type LocalFileStorageIntegrationSpec = z.infer<typeof LocalFileStorageIntegrationSpecSchema>;
export type VercelBlobFileStorageIntegrationSpec = z.infer<
  typeof VercelBlobFileStorageIntegrationSpecSchema
>;
