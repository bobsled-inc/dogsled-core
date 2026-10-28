export interface ResourceSpec {
  name: string;
  description?: string;
  api?: { endpoint?: string; method?: string };
  tool?: { tool_name?: string };
  input?: Record<string, { type?: string; required?: boolean; description?: string }>;
  output?: Record<string, { type?: string; path?: string; description?: string }>;
  extract?: {
    record_path?: string;
    table?: { primary_key?: string[]; trust_tier?: string };
    pagination?: { type?: string };
    incremental?: { cursor_field?: string; cursor_param?: string };
  };
  lookup?: Record<string, unknown>;
  billing?: { mode?: string };
}

export interface ModelBundleRef {
  name: string;
  displayName: string;
  martCount: number;
}

export interface IntegrationDetail {
  name: string;
  meta: {
    display_name: string;
    category: string;
    tags: string[];
    logo_url?: string;
    docs_url?: string;
    auth_setup: Array<{ env: string; description: string; docs_url?: string }>;
  };
  spec: {
    transport?: {
      base_url?: string;
      auth?: { type?: string };
      rate_limit?: { requests_per_second?: number; burst?: number };
      type?: string;
    };
  };
  resources: ResourceSpec[];
  modelBundle?: ModelBundleRef | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function parseOptionalString(value: unknown): string | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === 'string' ? value : null;
}

function parseAuthSetupEntry(
  value: unknown
): { env: string; description: string; docs_url?: string } | null {
  if (
    !isRecord(value) ||
    typeof value['env'] !== 'string' ||
    typeof value['description'] !== 'string'
  ) {
    return null;
  }

  const docsUrl = parseOptionalString(value['docs_url']);
  if (docsUrl === null) {
    return null;
  }

  return {
    env: value['env'],
    description: value['description'],
    docs_url: docsUrl,
  };
}

function parseResourceSpec(value: unknown): ResourceSpec | null {
  if (!isRecord(value) || typeof value['name'] !== 'string') {
    return null;
  }

  const description = parseOptionalString(value['description']);
  if (description === null) {
    return null;
  }

  for (const key of ['api', 'tool', 'input', 'output', 'extract', 'lookup', 'billing'] as const) {
    const nested = value[key];
    if (nested !== undefined && !isRecord(nested)) {
      return null;
    }
  }

  return {
    name: value['name'],
    description,
    api: value['api'] as ResourceSpec['api'] | undefined,
    tool: value['tool'] as ResourceSpec['tool'] | undefined,
    input: value['input'] as ResourceSpec['input'] | undefined,
    output: value['output'] as ResourceSpec['output'] | undefined,
    extract: value['extract'] as ResourceSpec['extract'] | undefined,
    lookup: value['lookup'] as ResourceSpec['lookup'] | undefined,
    billing: value['billing'] as ResourceSpec['billing'] | undefined,
  };
}

function parseModelBundle(value: unknown): ModelBundleRef | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (
    !isRecord(value) ||
    typeof value['name'] !== 'string' ||
    typeof value['displayName'] !== 'string' ||
    typeof value['martCount'] !== 'number' ||
    !Number.isFinite(value['martCount'])
  ) {
    return null;
  }

  return {
    name: value['name'],
    displayName: value['displayName'],
    martCount: value['martCount'],
  };
}

export function parseIntegrationDetail(value: unknown): IntegrationDetail | null {
  if (!isRecord(value) || typeof value['name'] !== 'string' || !isRecord(value['meta'])) {
    return null;
  }

  const meta = value['meta'];
  const category = parseOptionalString(meta['category']);
  const docsUrl = parseOptionalString(meta['docs_url']);
  const logoUrl = parseOptionalString(meta['logo_url']);
  const tags = meta['tags'];
  const authSetup = meta['auth_setup'];

  if (typeof meta['display_name'] !== 'string') {
    return null;
  }
  if (category === null || docsUrl === null || logoUrl === null) {
    return null;
  }
  if (tags !== undefined && !isStringArray(tags)) {
    return null;
  }

  let parsedAuthSetup: IntegrationDetail['meta']['auth_setup'] = [];
  if (authSetup !== undefined) {
    if (!Array.isArray(authSetup)) {
      return null;
    }
    parsedAuthSetup = [];
    for (const entry of authSetup) {
      const parsedEntry = parseAuthSetupEntry(entry);
      if (!parsedEntry) {
        return null;
      }
      parsedAuthSetup.push(parsedEntry);
    }
  }

  if (!Array.isArray(value['resources'])) {
    return null;
  }
  const resources: ResourceSpec[] = [];
  for (const resource of value['resources']) {
    const parsedResource = parseResourceSpec(resource);
    if (!parsedResource) {
      return null;
    }
    resources.push(parsedResource);
  }

  const specValue = value['spec'];
  if (specValue !== undefined && !isRecord(specValue)) {
    return null;
  }
  const transportValue = specValue?.['transport'];
  if (transportValue !== undefined && !isRecord(transportValue)) {
    return null;
  }

  const modelBundle = parseModelBundle(value['modelBundle']);
  if (value['modelBundle'] !== undefined && value['modelBundle'] !== null && !modelBundle) {
    return null;
  }

  return {
    name: value['name'],
    meta: {
      display_name: meta['display_name'],
      category: category ?? 'unknown',
      tags: tags ?? [],
      logo_url: logoUrl,
      docs_url: docsUrl,
      auth_setup: parsedAuthSetup,
    },
    spec: {
      transport: transportValue as IntegrationDetail['spec']['transport'] | undefined,
    },
    resources,
    modelBundle,
  };
}
