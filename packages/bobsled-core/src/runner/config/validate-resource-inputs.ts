import type { ResolvedPipeline, ValidationIssue } from './loader.js';
import type { InputMatrix } from './schema.js';
import { MAX_INPUT_MATRIX_AXIS_VALUES, MAX_INPUT_MATRIX_COMBINATIONS } from './input-matrix.js';
import { findProjectResource, type BobsledProject } from './project-files.js';

interface ResourceInputDefinitions {
  [inputName: string]: unknown;
}

interface ResourceInputSchema {
  name: string;
  input?: ResourceInputDefinitions;
}

interface ResourceCatalogEntry {
  resource: ResourceInputSchema;
}

interface ResourceCatalog {
  getResources(source: string): ResourceCatalogEntry[];
}

interface ParsedLocalResource {
  input?: unknown;
  extract?: { incremental?: { strategy?: unknown } };
}

interface InputDefinition {
  type?: unknown;
  enum?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  minLength?: unknown;
  maxLength?: unknown;
  pattern?: unknown;
}

/**
 * Validate targeted input overrides against the selected resource schema.
 *
 * Pipeline-wide inputs intentionally remain broadcasts: each extractor
 * resource filters that map to its own declared keys. A resource-level input
 * is different—the author named the exact consumer—so misspellings must fail
 * during Dogsled validation instead of surviving until a child process starts.
 */
export function validateResourceInputOverrides(
  pipeline: ResolvedPipeline,
  catalog: ResourceCatalog | undefined,
  project: BobsledProject,
  errors: ValidationIssue[]
): void {
  let resources: ResourceInputSchema[];
  try {
    resources = catalog?.getResources(pipeline.source).map((entry) => entry.resource) ?? [];
  } catch {
    // A project-local source is valid even when it has no bundled catalog
    // entry. Keep validating its on-disk resource schemas below.
    resources = [];
  }
  const byName = new Map(resources.map((resource) => [resource.name, resource]));

  for (const resource of pipeline.resources) {
    const inputs = resource.override?.inputs;
    if (!inputs) continue;
    const local = findProjectResource(project, pipeline.source, resource.name);
    let schema: ResourceInputDefinitions | undefined;
    if (local) {
      const parsed = local.entry.document as ParsedLocalResource | null;
      schema =
        typeof parsed?.input === 'object' && parsed.input !== null && !Array.isArray(parsed.input)
          ? (parsed.input as ResourceInputDefinitions)
          : {};
    } else {
      schema = byName.get(resource.name)?.input;
    }
    if (!schema) continue;
    const unknown = Object.keys(inputs).filter((key) => !Object.hasOwn(schema, key));
    if (unknown.length === 0) continue;
    const available = Object.keys(schema);
    errors.push({
      path: `bobsled.yml:pipelines.${pipeline.name}.resources`,
      message:
        `Unknown input(s) [${unknown.join(', ')}] for resource ` +
        `"${resource.requestedName ?? resource.name}".` +
        (available.length > 0 ? ` Available inputs: ${available.join(', ')}.` : ''),
    });
  }
}

function readResourceDefinition(
  pipeline: ResolvedPipeline,
  resourceName: string,
  catalog: ResourceCatalog | undefined,
  project: BobsledProject
): ParsedLocalResource | undefined {
  const local = findProjectResource(project, pipeline.source, resourceName);
  if (local) return (local.entry.document as ParsedLocalResource | null) ?? undefined;
  try {
    const found = catalog
      ?.getResources(pipeline.source)
      .find(({ resource }) => resource.name === resourceName);
    return found?.resource as ParsedLocalResource | undefined;
  } catch {
    return undefined;
  }
}

function normalizeMatrixValue(
  value: string | number | boolean,
  definition: InputDefinition
): string | number | boolean | undefined {
  switch (definition.type) {
    case 'string':
    case 'timestamp':
      return typeof value === 'string' ? value : undefined;
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined;
    default:
      return undefined;
  }
}

function matrixValueMatchesConstraints(
  value: string | number | boolean,
  definition: InputDefinition
): boolean {
  if (Array.isArray(definition.enum) && !definition.enum.includes(value)) {
    return false;
  }
  if (typeof value === 'number') {
    if (typeof definition.minimum === 'number' && value < definition.minimum) {
      return false;
    }
    if (typeof definition.maximum === 'number' && value > definition.maximum) {
      return false;
    }
  }
  if (typeof value === 'string') {
    if (typeof definition.minLength === 'number' && value.length < definition.minLength) {
      return false;
    }
    if (typeof definition.maxLength === 'number' && value.length > definition.maxLength) {
      return false;
    }
    if (typeof definition.pattern === 'string') {
      try {
        if (!new RegExp(definition.pattern).test(value)) {
          return false;
        }
      } catch {
        return false;
      }
    }
  }
  return true;
}

function matrixTupleKey(tuple: Record<string, string | number | boolean>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(tuple).sort(([a], [b]) => a.localeCompare(b)))
  );
}

/** Validate and normalize all authored matrix tuples before a runner starts. */
export function validateResourceInputMatrices(
  pipeline: ResolvedPipeline,
  catalog: ResourceCatalog | undefined,
  project: BobsledProject,
  errors: ValidationIssue[]
): void {
  for (const resource of pipeline.resources) {
    const matrix = resource.override?.inputMatrix as InputMatrix | undefined;
    if (!matrix) continue;
    const definition = readResourceDefinition(pipeline, resource.name, catalog, project);
    const input =
      definition?.input && typeof definition.input === 'object' && !Array.isArray(definition.input)
        ? (definition.input as Record<string, InputDefinition>)
        : {};
    const conflictNames = new Set([
      ...Object.keys(resource.override?.inputs ?? {}),
      ...Object.keys(pipeline.inputs ?? {}),
    ]);
    const seen = new Set<string>();
    const normalizedAxes: Array<[string, Array<string | number | boolean>]> = [];
    let hasInvalidValue = false;
    let combinations = 1;
    for (const [axis, values] of Object.entries(matrix.axes)) {
      if (!Object.hasOwn(input, axis)) {
        hasInvalidValue = true;
        errors.push({
          path: `bobsled.yml:pipelines.${pipeline.name}.resources.${resource.name}.input_matrix.axes.${axis}`,
          message: `input_matrix axis "${axis}" is not a declared input of resource "${resource.name}".`,
        });
        continue;
      }
      if (conflictNames.has(axis)) {
        errors.push({
          path: `bobsled.yml:pipelines.${pipeline.name}.resources.${resource.name}.input_matrix.axes.${axis}`,
          message: `input_matrix axis "${axis}" conflicts with an existing pipeline or resource input override.`,
        });
      }
      if (values.length > MAX_INPUT_MATRIX_AXIS_VALUES) {
        errors.push({
          path: `bobsled.yml:pipelines.${pipeline.name}.resources.${resource.name}.input_matrix.axes.${axis}`,
          message:
            `input_matrix axis "${axis}" contains ${values.length} values; ` +
            `the maximum is ${MAX_INPUT_MATRIX_AXIS_VALUES}.`,
        });
        hasInvalidValue = true;
      }
      combinations =
        combinations > MAX_INPUT_MATRIX_COMBINATIONS / values.length
          ? MAX_INPUT_MATRIX_COMBINATIONS + 1
          : combinations * values.length;
      const normalizedValues: Array<string | number | boolean> = [];
      for (const value of values) {
        const normalized = normalizeMatrixValue(value, input[axis]!);
        if (normalized === undefined || !matrixValueMatchesConstraints(normalized, input[axis]!)) {
          hasInvalidValue = true;
          errors.push({
            path: `bobsled.yml:pipelines.${pipeline.name}.resources.${resource.name}.input_matrix.axes.${axis}`,
            message: `input_matrix value ${JSON.stringify(value)} is incompatible with input "${axis}".`,
          });
        } else {
          normalizedValues.push(normalized);
        }
      }
      normalizedAxes.push([axis, normalizedValues]);
    }
    if (combinations > MAX_INPUT_MATRIX_COMBINATIONS) {
      errors.push({
        path: `bobsled.yml:pipelines.${pipeline.name}.resources.${resource.name}.input_matrix`,
        message:
          `input_matrix expands to more than ${MAX_INPUT_MATRIX_COMBINATIONS} combinations; ` +
          `the maximum is ${MAX_INPUT_MATRIX_COMBINATIONS}.`,
      });
    }
    const strategy = definition?.extract?.incremental?.strategy;
    if (strategy !== 'full_refresh') {
      errors.push({
        path: `bobsled.yml:pipelines.${pipeline.name}.resources.${resource.name}.input_matrix`,
        message:
          `input_matrix is currently supported only for full_refresh extraction resources; ` +
          `"${resource.name}" declares incremental strategy "${String(strategy)}".`,
      });
    }

    // Matrix values are normalized before duplicate detection, so equivalent
    // authored tuples cannot issue the same request twice.
    const axes = normalizedAxes;
    const tuple: Record<string, string | number | boolean> = Object.create(null);
    const visit = (index: number): void => {
      if (index === axes.length) {
        const key = matrixTupleKey(tuple);
        if (seen.has(key)) {
          errors.push({
            path: `bobsled.yml:pipelines.${pipeline.name}.resources.${resource.name}.input_matrix`,
            message: `input_matrix contains duplicate normalized tuple ${key}.`,
          });
        }
        seen.add(key);
        return;
      }
      const [axis, values] = axes[index]!;
      for (const value of values) {
        tuple[axis] = value;
        visit(index + 1);
      }
    };
    if (!hasInvalidValue && axes.length > 0 && combinations <= 10_000) visit(0);
  }
}
