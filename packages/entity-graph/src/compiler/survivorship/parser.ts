import * as fs from 'node:fs';

import YAML from 'yaml';

import { collectYamlFiles } from '@bobsled-inc/model-spec';
import { formatSpecValidationMessage } from '@bobsled-inc/protocol';
import { discoverResolutionSpecs } from '../identity/parser.js';
import { SurvivorshipSpecSchema } from './schema.js';

import type { SurvivorshipSpec } from './schema.js';
import type { ResolvedSurvivorshipSpec } from './types.js';

export interface ParsedSurvivorshipSpec {
  name: string;
  filePath: string;
  raw: SurvivorshipSpec;
}

function parseSpecFromRaw(filePath: string, raw: unknown): ParsedSurvivorshipSpec {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid YAML in ${filePath}`);
  }

  const rawObject = raw as Record<string, unknown>;
  if (rawObject.type !== 'survivorship') {
    throw new Error(`${filePath} is not a survivorship spec (type: ${String(rawObject.type)})`);
  }

  const parsed = SurvivorshipSpecSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      formatSpecValidationMessage('survivorship', filePath, parsed.error, {
        schema: SurvivorshipSpecSchema,
      })
    );
  }

  return {
    name: parsed.data.name,
    filePath,
    raw: parsed.data,
  };
}

export function parseSurvivorshipSpec(filePath: string): ParsedSurvivorshipSpec {
  const content = fs.readFileSync(filePath, 'utf-8');
  const raw: unknown = YAML.parse(content);
  return parseSpecFromRaw(filePath, raw);
}

export function discoverSurvivorshipSpecs(entityGraphDir: string): ParsedSurvivorshipSpec[] {
  const specs: ParsedSurvivorshipSpec[] = [];
  if (!fs.existsSync(entityGraphDir)) {
    return specs;
  }

  for (const filePath of collectYamlFiles(entityGraphDir)) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const raw: unknown = YAML.parse(content);
      if (
        !raw ||
        typeof raw !== 'object' ||
        (raw as Record<string, unknown>).type !== 'survivorship'
      ) {
        continue;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse survivorship spec ${filePath}: ${message}`);
    }

    specs.push(parseSurvivorshipSpec(filePath));
  }

  return specs;
}

export function resolveSurvivorshipSpec(
  parsed: ParsedSurvivorshipSpec,
  entityGraphDir: string,
  defaultSchema: string
): ResolvedSurvivorshipSpec {
  const resolutionSpecs = discoverResolutionSpecs(entityGraphDir);
  const resolution = resolutionSpecs.find((spec) => {
    const resolutionEntity = spec.raw.name.replace(/_resolution$/, '');
    return (
      spec.raw.name === parsed.raw.resolution_ref ||
      resolutionEntity === parsed.raw.resolution_ref ||
      resolutionEntity === parsed.raw.name.replace(/_survivorship$/, '')
    );
  });

  if (!resolution) {
    throw new Error(
      `Survivorship spec ${parsed.name} references unknown resolution "${parsed.raw.resolution_ref}".`
    );
  }

  const defaultRecencyMode =
    parsed.raw.attribute_rules == null || parsed.raw.attribute_rules.length === 0;
  if (defaultRecencyMode && resolution.raw.standardize.length === 0) {
    throw new Error(
      `Survivorship spec ${parsed.name} omits attribute_rules but resolution ${resolution.raw.name} has no standardize fields to synthesize from.`
    );
  }

  const attributeRules = defaultRecencyMode
    ? resolution.raw.standardize.map((standardize) => ({
        attribute: standardize.field,
        strategy: 'recency' as const,
        sourceOrder: resolution.raw.inputs.map((input) => input.ref),
        timestampField: parsed.raw.default_timestamp_field ?? 'updated_at',
        fallback: undefined,
        valuePriority: [],
        pinnedValue: undefined,
      }))
    : parsed.raw.attribute_rules!.map((rule) => ({
        attribute: rule.attribute,
        strategy: rule.strategy,
        sourceOrder: rule.source_order ?? [],
        timestampField: rule.timestamp_field,
        fallback: rule.fallback,
        valuePriority: rule.value_priority ?? [],
        pinnedValue: rule.pinned_value,
      }));

  return {
    name: parsed.raw.name,
    entity: parsed.raw.name.replace(/_survivorship$/, ''),
    description: parsed.raw.description,
    resolutionRef: resolution.raw.name,
    resolutionEntity: resolution.raw.name.replace(/_resolution$/, ''),
    entityIdPolicy: {
      strategy: parsed.raw.entity_id_policy?.strategy ?? 'stable_uuid',
    },
    attributeRules,
    targetSchema:
      parsed.raw.outputs?.target_schema ?? resolution.raw.outputs?.target_schema ?? defaultSchema,
    defaultRecencyMode,
  };
}
