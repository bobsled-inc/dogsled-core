import type { SupportedDialect } from '../compiler/dialect.js';

export interface OssieConnectionContext {
  defaultConnection?: string;
  datasetBindings?: Array<{
    documentPath: string;
    dataset: string;
    connection: string;
  }>;
  connectionAliases?: Record<string, string>;
}

export interface OssiePhysicalSchema {
  documentPath: string;
  dataset: string;
  connection: string;
  source: string;
  dialect: SupportedDialect;
  columns: Array<{ name: string; sqlType: string }>;
}

export interface ImportOssieDocumentsRequest {
  documents: Array<{ path: string; content: string }>;
  context?: {
    connections?: OssieConnectionContext;
    physicalSchemas?: OssiePhysicalSchema[];
  };
  options?: { strict?: boolean };
}

export interface ImportOssieOptions {
  /** Compatibility wrapper origin. New callers should use importOssieDocuments. */
  sourcePath: string;
  /** Legacy connection aliases. */
  connections?: Record<string, string>;
}
