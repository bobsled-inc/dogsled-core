import type { z } from 'zod';

import type { ResourceSpec } from '@bobsled-inc/extractor/extractor';
import type { MetaSpecSchema, SourceSpecSchema } from './validate.js';
import type {
  QueryContextInputSpec,
  QueryFilterFieldSpec,
  QueryResourceSummary,
  QuerySearchSpec,
} from './query-resources/catalog.js';

export type { CATEGORIES } from './validate.js';

export type Category = z.infer<typeof MetaSpecSchema>['category'];

export type MetaSpec = z.infer<typeof MetaSpecSchema>;

export type AuthSetupEntry = NonNullable<MetaSpec['auth_setup']>[number];

export type SourceType = 'api' | 'mcp' | 'db';

export interface SourceSummary {
  name: string;
  display_name: string;
  category: Category;
  tags: string[];
  resource_count: number;
  source_type: SourceType;
  integration_type: SourceType;
}

export interface Source {
  name: string;
  meta: MetaSpec;
  spec: SourceSpec;
  resource_names: string[];
}

export interface SourceResource {
  source_name: string;
  resource: ResourceSpec;
}

export type SourceSpec = z.infer<typeof SourceSpecSchema>;
export type IntegrationType = SourceType;
export type IntegrationSummary = SourceSummary;
export type Integration = Source;
export type IntegrationResource = SourceResource & { integration_name: string };

export type { QueryContextInputSpec, QueryFilterFieldSpec, QueryResourceSummary, QuerySearchSpec };
