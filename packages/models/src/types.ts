export type TrustTier = 'bronze' | 'silver' | 'gold';

export type SemanticRole =
  | 'entity_id'
  | 'measure'
  | 'event_timestamp'
  | 'time_dimension'
  | 'categorical';

export type JoinType = 'left' | 'inner' | 'cross' | 'full';

export interface ResourceOutputField {
  type: string;
  description?: string;
  unit?: string;
  path?: string;
}

export interface ResourceSpecLike {
  name: string;
  tableResourceName?: string;
  description: string;
  output?: Record<string, ResourceOutputField>;
  extract?: {
    table?: {
      primary_key?: string[];
    };
  };
}

export interface SourceColumnSpec {
  name: string;
  type: string;
  description?: string;
  unit?: string;
}

export interface SourceSpecFile {
  spec_version: '0.2';
  name: string;
  type: 'source';
  source_type: 'warehouse_table';
  connection: string;
  table: string;
  description?: string;
  trust_tier: TrustTier;
  schema: {
    columns: SourceColumnSpec[];
  };
}

export interface DataTestSpec {
  type: 'not_null' | 'unique' | 'accepted_values' | 'custom';
  column?: string;
  values?: Array<string | number>;
  sql?: string;
}

export interface JoinPreAggregateSpec {
  group_by: string[];
  columns: Array<{
    name: string;
    expr: string;
  }>;
}

export interface JoinSpec {
  ref: string;
  type: JoinType;
  on: string;
  description?: string;
  pre_aggregate?: JoinPreAggregateSpec;
}

export interface ModelColumnSpec {
  name: string;
  expr: string;
  description?: string;
  type?: string;
  unit?: string;
  primary_key?: boolean;
  not_null?: boolean;
  semantic_role?: SemanticRole;
  references?: string;
  tags?: string[];
  business_rule?: string;
}

export interface ModelSpecFile {
  spec_version: '0.2';
  name: string;
  type: 'model';
  description: string;
  grain: string | string[];
  source: {
    ref: string;
    filter?: string;
  };
  joins?: JoinSpec[];
  columns: ModelColumnSpec[];
  group_by?: string[];
  tags?: string[];
  owner?: string;
  trust_tier?: TrustTier;
  tests?: DataTestSpec[];
  materialization: {
    type: 'view' | 'table';
  };
}

export interface MetricSpecFile {
  spec_version: '0.2';
  type: 'metric';
  name: string;
  description?: string;
  model?: string;
  models?: string[];
  expression: string;
  synonyms?: string[];
  tags?: string[];
}

export interface RelationshipSpecFile {
  spec_version: '0.2';
  type: 'relationship';
  name: string;
  description?: string;
  left_model: string;
  right_model: string;
  join_columns: Array<{
    left: string;
    right: string;
  }>;
  join_type?: 'inner' | 'left';
  relationship_type: 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';
  tags?: string[];
}

export interface GeneratedFile {
  path: string;
  content: string;
  kind: 'source' | 'model' | 'metric' | 'relationship';
}

export interface ModelPackageManifest {
  name: string;
  displayName: string;
  description: string;
  tags: string[];
  connection?: string;
  includeResources?: string[];
  marts: ModelSpecFile[];
  metrics: MetricSpecFile[];
  relationships: RelationshipSpecFile[];
}

export interface ModelPackage {
  name: string;
  displayName: string;
  description: string;
  connection: string;
  tags: string[];
  resourceNames: string[];
  sourceSpecs: SourceSpecFile[];
  stagingSpecs: ModelSpecFile[];
  martSpecs: ModelSpecFile[];
  metricSpecs: MetricSpecFile[];
  relationshipSpecs: RelationshipSpecFile[];
  files: GeneratedFile[];
}

export interface ModelPackageSummary {
  name: string;
  displayName: string;
  description: string;
  tags: string[];
  resourceCount: number;
  stagingCount: number;
  martCount: number;
  metricCount: number;
  relationshipCount: number;
  totalFiles: number;
}

export interface PackageBuildOptions {
  rawSchema?: string;
  sourceDir?: string;
  modelDir?: string;
  metricDir?: string;
  relationshipDir?: string;
}

export interface InstallModelPackageOptions extends PackageBuildOptions {
  cwd?: string;
  overwrite?: boolean;
}

export interface InstallModelPackageResult {
  packageName: string;
  writtenFiles: string[];
  sourceCount: number;
  stagingCount: number;
  martCount: number;
  metricCount: number;
  relationshipCount: number;
}
