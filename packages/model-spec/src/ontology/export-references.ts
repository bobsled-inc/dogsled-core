import { record } from '../interchange/common.js';

/** Rebase structured native build references; opaque expressions need reviewed aliases. */
export function rebaseNativeExtensions(
  value: unknown,
  references: ReadonlyMap<string, string>
): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((child) => rebaseNativeExtensions(child, references));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'custom_extensions' && Array.isArray(child)) {
      for (const extension of child) {
        const item = record(extension);
        if (item['vendor_name'] !== 'BOBSLED' || typeof item['data'] !== 'string') continue;
        const payload: unknown = JSON.parse(item['data']);
        rebase(payload, references);
        (extension as Record<string, unknown>)['data'] = JSON.stringify(payload);
      }
    } else rebaseNativeExtensions(child, references);
  }
}
function rebase(value: unknown, references: ReadonlyMap<string, string>): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child !== 'string') {
      rebase(child, references);
      continue;
    }
    const replacement = references.get(child);
    if (key === 'ref' && replacement) {
      (value as Record<string, unknown>)[key] = replacement;
      continue;
    }
    for (const [native, alias] of references) {
      if (native !== alias && (child === native || child.includes(`${native}.`))) {
        throw new Error(
          `Native expression refers to renamed dataset ${native}. Use the native dataset name as its scope alias.`
        );
      }
    }
  }
}
