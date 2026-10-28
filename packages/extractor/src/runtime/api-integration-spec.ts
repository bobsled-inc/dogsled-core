import type { SqlTransport, Transport, TransportConfig } from '../framework/core/index.js';
import type { ApiIntegrationSpec, SourceSpec } from '../types/index.js';

export function buildApiIntegrationSpec(
  source: SourceSpec,
  transport: Exclude<Transport, SqlTransport>
): ApiIntegrationSpec {
  return {
    spec_version: '1',
    type: 'integration',
    name: source.name,
    source_type: 'api',
    auth_env_vars: source.auth_env_vars,
    transport: stripSourceTransportFields(transport),
  };
}

export function stripSourceTransportFields(
  transport: Exclude<Transport, SqlTransport>
): TransportConfig {
  const { id: _id, description: _description, policy: _policy, ...config } = transport;
  return config;
}
