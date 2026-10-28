import * as fs from 'node:fs';
import * as path from 'node:path';

import YAML from 'yaml';

import { collectYamlFiles, readCsv } from '@bobsled-inc/model-spec';
import { formatSpecValidationMessage } from '@bobsled-inc/protocol';
import { discoverResolutionSpecs } from '../identity/parser.js';
import { TruthsetSpecSchema } from './schema.js';

import type { TruthsetSpec } from './schema.js';

export interface ParsedTruthsetSpec {
  name: string;
  filePath: string;
  csvPath: string;
  raw: TruthsetSpec;
}

export interface TruthsetLabel {
  pair_id: string;
  label: 'merge' | 'not_match';
}

export interface ResolvedTruthsetSpec {
  name: string;
  entity: string;
  description: string;
  resolutionRef: string;
  resolutionEntity: string;
  csvPath: string;
  delimiter: string;
  minAutoMergePrecision: number;
}

export function parseTruthsetSpec(filePath: string): ParsedTruthsetSpec {
  const content = fs.readFileSync(filePath, 'utf-8');
  const raw: unknown = YAML.parse(content);

  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid YAML in ${filePath}`);
  }

  const rawObject = raw as Record<string, unknown>;
  if (rawObject.type !== 'truthset') {
    throw new Error(`${filePath} is not a truthset spec (type: ${String(rawObject.type)})`);
  }

  const parsed = TruthsetSpecSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      formatSpecValidationMessage('truthset', filePath, parsed.error, {
        schema: TruthsetSpecSchema,
      })
    );
  }

  const csvPath = path.resolve(path.dirname(filePath), parsed.data.labels.path);
  if (!fs.existsSync(csvPath)) {
    throw new Error(`Truthset CSV not found: ${csvPath}`);
  }

  return {
    name: parsed.data.name,
    filePath,
    csvPath,
    raw: parsed.data,
  };
}

export function discoverTruthsetSpecs(entityGraphDir: string): ParsedTruthsetSpec[] {
  if (!fs.existsSync(entityGraphDir)) {
    return [];
  }

  const specs: ParsedTruthsetSpec[] = [];
  for (const filePath of collectYamlFiles(entityGraphDir)) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const raw: unknown = YAML.parse(content);
      if (!raw || typeof raw !== 'object' || (raw as Record<string, unknown>).type !== 'truthset') {
        continue;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse truthset spec ${filePath}: ${message}`);
    }

    specs.push(parseTruthsetSpec(filePath));
  }

  return specs;
}

export function resolveTruthsetSpec(
  parsed: ParsedTruthsetSpec,
  entityGraphDir: string
): ResolvedTruthsetSpec {
  const resolutionSpecs = discoverResolutionSpecs(entityGraphDir);
  const resolution = resolutionSpecs.find((spec) => {
    const entity = spec.raw.name.replace(/_resolution$/, '');
    return spec.raw.name === parsed.raw.resolution_ref || entity === parsed.raw.resolution_ref;
  });

  if (!resolution) {
    throw new Error(
      `Truthset ${parsed.name} references unknown resolution "${parsed.raw.resolution_ref}".`
    );
  }

  return {
    name: parsed.raw.name,
    entity: parsed.raw.name.replace(/_truthset$/, ''),
    description: parsed.raw.description,
    resolutionRef: resolution.raw.name,
    resolutionEntity: resolution.raw.name.replace(/_resolution$/, ''),
    csvPath: parsed.csvPath,
    delimiter: parsed.raw.labels.delimiter,
    minAutoMergePrecision: parsed.raw.targets?.min_auto_merge_precision ?? 0.98,
  };
}

export function loadTruthsetLabels(spec: ResolvedTruthsetSpec): TruthsetLabel[] {
  const csv = fs.readFileSync(spec.csvPath, 'utf-8');
  const parsed = readCsv(csv, {
    delimiter: spec.delimiter,
    expectedColumns: ['pair_id', 'label'],
  });

  return parsed.rows.map((row) => {
    const pairId = row[0]?.trim();
    const label = row[1]?.trim().toLowerCase();
    if (!pairId || (label !== 'merge' && label !== 'not_match')) {
      throw new Error(
        `Truthset ${spec.name} has invalid row. Expected pair_id and label in {merge, not_match}.`
      );
    }
    return {
      pair_id: pairId,
      label,
    };
  });
}
