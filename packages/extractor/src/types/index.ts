/**
 * Core types for the Dogsled Extractor.
 */

import type { z } from 'zod';

import type { ActionSpecSchema } from '../schemas/action.js';
import type { IntegrationSpecSchema } from '../schemas/integration.js';
import type { ResourceSpecSchema } from '../schemas/resource.js';
import type { ExtractorConfigSchema } from '../schemas/config.js';
import type { ExtractorStateSchema } from '../schemas/state.js';
import type { ExtractIntentsSchema } from '../schemas/extract-intents.js';

// Spec types (inferred from Zod schemas)

export type ActionSpec = z.infer<typeof ActionSpecSchema>;
export type IntegrationSpec = z.infer<typeof IntegrationSpecSchema>;
export type ResourceSpec = z.infer<typeof ResourceSpecSchema>;
export type ExtractorConfig = z.infer<typeof ExtractorConfigSchema>;
export type ExtractorState = z.infer<typeof ExtractorStateSchema>;
export type ExtractIntentsManifest = z.infer<typeof ExtractIntentsSchema>;

// Narrowed types for API-only code paths
export type {
  ActionTransport,
  ApiAction,
  FieldMapping,
  FieldMappingEntry,
  WebhookAction,
} from '../framework/extractor/action.js';
export type {
  ApiIntegrationSpec,
  ApiResourceSpec,
  BillableResourceBilling,
  QueryFilterFieldSpec,
  QueryOperator,
  QuerySearchSpec,
  QuerySpec,
  SourceSpec,
  HttpApiResourceSpec,
  LookupOnlyApiResourceSpec,
  FileCopyResourceSpec,
  FileResourceSpec,
  WarehouseResourceSpec,
} from '../framework/extractor/resource.js';
export type { ExtractIntentPlan, ExtractIntentSeed, ExtractIntentStep } from './extract-intents.js';

// Message protocol types — re-exported from @bobsled-inc/protocol

export type {
  ColumnType,
  LoadStrategy,
  SchemaBehavior,
  SchemaColumn,
  SchemaMessage,
  RecordMessage,
  StateMessage,
  BatchEncoding,
  BatchFormat,
  BatchMessage,
  ReplaceMessage,
  FileMessage,
  LogMessage,
  MetricMessage,
  ProgressEventType,
  ProgressMessage,
  StdoutMessage,
  StderrMessage,
  RunSummaryMessage,
  RunSummaryResourceEntry,
} from '@bobsled-inc/protocol';
