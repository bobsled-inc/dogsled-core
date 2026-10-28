/**
 * Refreshable BigQuery / GCS credential support.
 *
 * The implementation now lives in `@bobsled-inc/connections`
 * (`runtime/refreshable-token.ts`) so the loader and the connections warehouse
 * runners (Model Spec models + entity-graph) share ONE refresh implementation instead
 * of forking divergent copies. This module re-exports it to preserve the
 * loader's existing `../bigquery-auth.js` import sites.
 */

export {
  RefreshableTokenSource,
  createRefreshableAuthClient,
  createTokenCommandProvider,
  parseTokenCommandOutput,
  isInvalidCredentialsError,
  TOKEN_REFRESH_SKEW_SECONDS,
} from '@bobsled-inc/connections';
export type { BigQueryAccessToken, BigQueryTokenProvider } from '@bobsled-inc/connections';
