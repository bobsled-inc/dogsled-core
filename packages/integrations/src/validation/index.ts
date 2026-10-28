/**
 * `@bobsled-inc/integrations/validation` — clean runtime validation island.
 *
 * This entry intentionally imports only generated data and declaration-only
 * types. It must remain safe for bundled/serverless project validation.
 */

export {
  INTEGRATION_VALIDATION_CATALOG_SCHEMA_VERSION,
  type IntegrationValidationAuthSetup,
  type IntegrationValidationCatalog,
  type IntegrationValidationForEach,
  type IntegrationValidationResource,
  type IntegrationValidationSource,
} from './types.js';
export { INTEGRATION_VALIDATION_CATALOG } from './generated-data.js';
