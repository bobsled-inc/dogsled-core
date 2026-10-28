import type { Integration } from './integrations';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function authTypeFromTransport(transport: unknown): string | undefined {
  if (!isRecord(transport)) return undefined;
  const auth = transport.auth;
  if (isRecord(auth) && typeof auth.type === 'string') {
    return auth.type;
  }
  return typeof transport.type === 'string' ? transport.type : undefined;
}

export function resolveAuthType(spec: Integration['spec']): string {
  const legacySpec = spec as Record<string, unknown>;
  const transports = Array.isArray(legacySpec.transports) ? legacySpec.transports : [];
  const defaultTransport = transports.find(
    (transport) =>
      isRecord(transport) &&
      typeof transport.id === 'string' &&
      transport.id === legacySpec.default_transport
  );
  const sourceAuthType = authTypeFromTransport(defaultTransport ?? transports[0]);
  if (sourceAuthType) {
    return sourceAuthType;
  }

  const legacyAuthType = authTypeFromTransport(legacySpec.transport);
  if (legacyAuthType) {
    return legacyAuthType;
  }

  if (isRecord(legacySpec.auth) && typeof legacySpec.auth.type === 'string') {
    return legacySpec.auth.type;
  }

  return 'unknown';
}
