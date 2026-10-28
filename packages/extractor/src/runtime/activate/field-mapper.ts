import type { FieldMapping, FieldMappingEntry } from '../../framework/extractor/action.js';
import { ExtractorDataError } from '../errors.js';

/** Record used as the source or mapped payload for action activation. */
export interface ActivationRecord {
  [key: string]: unknown;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function normalizeEntry(entry: FieldMappingEntry): {
  source: string;
  transform: 'as_is' | 'to_string';
  defaultValue: unknown;
  required: boolean;
} {
  if (typeof entry === 'string') {
    return {
      source: entry,
      transform: 'as_is',
      defaultValue: undefined,
      required: false,
    };
  }

  return {
    source: entry.source,
    transform: entry.transform ?? 'as_is',
    defaultValue: entry.default,
    required: entry.required ?? false,
  };
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'object') {
    return JSON.stringify(value);
  }

  return String(value);
}

/** Maps source record fields into the payload expected by an action transport. */
export function mapFields(mapping: FieldMapping, record: ActivationRecord): ActivationRecord {
  const mapped: ActivationRecord = Object.create(null) as ActivationRecord;
  const usedSourceFields = new Set<string>();

  for (const [targetField, entry] of Object.entries(mapping.fields)) {
    const normalized = normalizeEntry(entry);
    usedSourceFields.add(normalized.source);

    let value = hasOwn(record, normalized.source) ? record[normalized.source] : undefined;
    if (value === undefined || value === null) {
      if (normalized.defaultValue !== undefined) {
        value = normalized.defaultValue;
      } else if (normalized.required) {
        throw new ExtractorDataError(`Missing required mapped field "${normalized.source}"`);
      } else {
        value = undefined;
      }
    }

    mapped[targetField] =
      normalized.transform === 'to_string' && value !== undefined ? stringifyValue(value) : value;
  }

  const unmappedSourceFields = Object.keys(record).filter((key) => !usedSourceFields.has(key));
  if (mapping.unmapped_fields === 'error' && unmappedSourceFields.length > 0) {
    throw new ExtractorDataError(`Unmapped input fields: ${unmappedSourceFields.join(', ')}`);
  }

  if (mapping.unmapped_fields === 'passthrough') {
    for (const key of unmappedSourceFields) {
      if (!hasOwn(mapped, key)) {
        mapped[key] = record[key];
      }
    }
  }

  return mapped;
}
