import type { HttpApiResourceSpec } from './audit-types.js';

const INPUT_TEMPLATE_RE = /\$\{\{\s*input\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function collectHttpParamBodyInputRefs(api: HttpApiResourceSpec['api']): Set<string> {
  const refs = new Set<string>();
  collectInputRefs(api.query_params, refs);
  collectInputRefs(api.request_body, refs);
  return refs;
}

function collectInputRefs(value: unknown, refs: Set<string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(INPUT_TEMPLATE_RE)) {
      const inputName = match[1];
      if (inputName) {
        refs.add(inputName);
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectInputRefs(item, refs);
    }
    return;
  }

  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      collectInputRefs(item, refs);
    }
  }
}
