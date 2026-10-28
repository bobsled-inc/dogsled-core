import { buildSeedKey } from './key.js';
import { classifySeedType, unsupportedSeedTypeMessage, type SeedTypeFamily } from './types.js';

import type { ParsedSeedSpec } from './parser.js';
import type { CsvReadResult } from './csv-reader.js';

export interface SeedValidationIssue {
  row: number;
  column: string;
  code: 'missing_header' | 'required' | 'type' | 'unique';
  message: string;
}

export function getSeedUniqueColumns(spec: ParsedSeedSpec): string[] {
  const configured = spec.spec.validation?.unique_columns;
  if (configured && configured.length > 0) {
    return configured;
  }

  return spec.spec.schema.columns
    .filter((column) => column.primary_key)
    .map((column) => column.name);
}

function isBlank(value: string | undefined): boolean {
  return value == null || value.trim() === '';
}

function isValidValueForType(value: string, family: SeedTypeFamily): boolean {
  const trimmed = value.trim();
  if (trimmed === '') {
    return true;
  }

  switch (family) {
    case 'text':
    case 'time':
      return true;
    case 'integer':
      return /^-?\d+$/.test(trimmed);
    case 'float':
    case 'exact':
      return !Number.isNaN(Number(value));
    case 'boolean':
      return ['true', 'false', '1', '0', 'yes', 'no'].includes(trimmed.toLowerCase());
    case 'date':
    case 'timestamp':
      return !Number.isNaN(Date.parse(value));
  }
}

export function validateSeedData(
  spec: ParsedSeedSpec,
  csvData: CsvReadResult
): { issues: SeedValidationIssue[] } {
  const issues: SeedValidationIssue[] = [];
  const headerIndex = new Map(
    csvData.headers.map((header, index) => [header.toLowerCase(), index])
  );
  const requiredColumns = spec.spec.validation?.required_columns ?? [];
  const missingRequiredColumns = requiredColumns.filter(
    (column) => !headerIndex.has(column.toLowerCase())
  );
  const uniqueColumns = getSeedUniqueColumns(spec);
  const missingUniqueColumns = uniqueColumns.filter(
    (column) => !headerIndex.has(column.toLowerCase())
  );
  const missingHeaderColumns = new Map<string, string>();
  for (const column of [...missingRequiredColumns, ...missingUniqueColumns]) {
    missingHeaderColumns.set(column.toLowerCase(), column);
  }
  const uniqueValues = new Map<string, number>();

  const families = new Map<string, SeedTypeFamily>();
  for (const column of spec.spec.schema.columns) {
    const classified = classifySeedType(column.type);
    if (classified) {
      families.set(column.name, classified.family);
    } else {
      issues.push({
        row: 1,
        column: column.name,
        code: 'type',
        message: unsupportedSeedTypeMessage(spec.name, column.name, column.type),
      });
    }
  }

  for (const column of missingHeaderColumns.values()) {
    issues.push({
      row: 1,
      column,
      code: 'missing_header',
      message: `Missing column "${column}" in CSV header.`,
    });
  }

  for (let rowIndex = 0; rowIndex < csvData.rows.length; rowIndex += 1) {
    const row = csvData.rows[rowIndex]!;

    for (const column of requiredColumns) {
      const columnIndex = headerIndex.get(column.toLowerCase());
      if (columnIndex == null) {
        continue;
      }
      const value = row[columnIndex];
      if (isBlank(value)) {
        issues.push({
          row: rowIndex + 2,
          column,
          code: 'required',
          message: `Row ${rowIndex + 2}: required column "${column}" is blank.`,
        });
      }
    }

    for (const column of spec.spec.schema.columns) {
      const columnIndex = headerIndex.get(column.name.toLowerCase());
      if (columnIndex == null) {
        continue;
      }
      const value = row[columnIndex];
      const family = families.get(column.name);
      if (value != null && family && !isValidValueForType(value, family)) {
        issues.push({
          row: rowIndex + 2,
          column: column.name,
          code: 'type',
          message: `Row ${rowIndex + 2}: column "${column.name}" has invalid ${column.type} value "${value}".`,
        });
      }
    }

    if (uniqueColumns.length > 0 && missingUniqueColumns.length === 0) {
      const keyValues = Object.fromEntries(
        uniqueColumns.map((column) => {
          const columnIndex = headerIndex.get(column.toLowerCase());
          const value = columnIndex == null ? null : (row[columnIndex] ?? null);
          return [column, value];
        })
      );
      const key = buildSeedKey(keyValues, uniqueColumns);
      const previousRow = uniqueValues.get(key);
      if (previousRow != null) {
        issues.push({
          row: rowIndex + 2,
          column: uniqueColumns.join(','),
          code: 'unique',
          message: `Row ${rowIndex + 2}: duplicate unique key ${key} (already seen on row ${previousRow}).`,
        });
      } else {
        uniqueValues.set(key, rowIndex + 2);
      }
    }
  }

  return { issues };
}
