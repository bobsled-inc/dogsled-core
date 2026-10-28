export type EditResult<T = void> = { ok: true; data: T } | { ok: false; error: string };

export interface EditOptions {
  projectDir: string;
  sourcesDir?: string;
  modelsDir?: string;
  metricsDir?: string;
  relationshipsDir?: string;
  vqsDir?: string;
  skipValidation?: boolean;
  dryRun?: boolean;
}

export type FieldMetadataPatch = Partial<{
  description: string;
  semantic_role: string;
  tags: string[];
  unit: string;
  format: string;
  pii: boolean;
  enum_values: string[];
  examples: unknown[];
  references: string;
  business_rule: string;
  quality_notes: string;
  owner: string;
  deprecated: boolean;
  embedding_candidate: boolean;
}>;

export interface EditFileResult {
  filePath: string;
  content: string;
}
