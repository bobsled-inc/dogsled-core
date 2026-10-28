import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import YAML from 'yaml';
import {
  ALLOWED_SPEC_TYPES,
  isAllowedSpecType,
  type AllowedSpecType,
} from '@/lib/entity-graph-spec-types';
import { assertValidSpecName, specYamlPath } from '@/lib/entity-graph-workspace';
import { isEntityGraphScenarioId, type EntityGraphScenarioId } from '@/lib/entity-graph-scenarios';
import { isPlainObject } from '@/lib/guards';
import { logServerError } from '@/lib/server-logging';
import type { EntityGraphRouteErrorResponse } from '@/lib/entity-graph-route-errors';

export const dynamic = 'force-dynamic';

type Params = Promise<{ name: string }>;

class SpecTypeMismatchError extends Error {
  readonly expected: AllowedSpecType;
  readonly actual: AllowedSpecType | 'unknown';

  constructor(expected: AllowedSpecType, actual: AllowedSpecType | 'unknown') {
    super(`Expected ${expected} spec but received ${actual}`);
    this.expected = expected;
    this.actual = actual;
  }
}

function errorResponse(status: number, body: EntityGraphRouteErrorResponse) {
  return NextResponse.json(body, { status });
}

interface ParsedSpecEnvelope {
  type?: unknown;
}

interface PutSpecBody {
  yaml: string;
}

function isPutSpecBody(value: unknown): value is PutSpecBody {
  return isPlainObject(value) && typeof value.yaml === 'string' && value.yaml.length > 0;
}

function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}

function isKnownRequestError(message: string): boolean {
  return (
    message === 'JSON object required' ||
    message === 'Body must include yaml string' ||
    message === 'Spec must be a YAML object' ||
    message.startsWith('Unsupported spec type:') ||
    message.startsWith('Unsupported scenario:') ||
    message.startsWith('Spec name must match')
  );
}

function readRequestedSpecType(request: Request): AllowedSpecType | null {
  const value = new URL(request.url).searchParams.get('type');
  if (value === null) {
    return null;
  }
  if (!isAllowedSpecType(value)) {
    throw new Error(`Unsupported spec type: ${value}`);
  }
  return value;
}

function readRequestedScenario(request: Request): EntityGraphScenarioId {
  const value = new URL(request.url).searchParams.get('scenario');
  if (value === null || value === '') {
    return 'default';
  }
  if (!isEntityGraphScenarioId(value)) {
    throw new Error(`Unsupported scenario: ${value}`);
  }
  return value;
}

function assertSpecMatchesExpectedType(
  spec: Record<string, unknown>,
  expected: AllowedSpecType | null
): void {
  if (expected === null) {
    return;
  }

  const actual = isAllowedSpecType(spec.type) ? spec.type : 'unknown';
  if (actual !== expected) {
    throw new SpecTypeMismatchError(expected, actual);
  }
}

async function readSpecObject(file: string): Promise<Record<string, unknown>> {
  const content = await fs.readFile(file, 'utf8');
  const parsed = YAML.parse(content);
  if (!isPlainObject(parsed)) {
    throw new Error('Spec file is not a valid YAML object');
  }
  return parsed;
}

async function assertExistingSpecMatchesType(
  file: string,
  expected: AllowedSpecType | null
): Promise<void> {
  if (expected === null) {
    return;
  }

  try {
    const existing = await readSpecObject(file);
    assertSpecMatchesExpectedType(existing, expected);
  } catch (error) {
    if (isNodeErrnoException(error) && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

export async function GET(request: Request, { params }: { params: Params }) {
  const { name } = await params;
  let requestedType: AllowedSpecType | null = null;
  let scenario: EntityGraphScenarioId = 'default';

  try {
    requestedType = readRequestedSpecType(request);
    scenario = readRequestedScenario(request);
    assertValidSpecName(name);

    const file = specYamlPath(name, scenario);
    const content = await fs.readFile(file, 'utf8');
    const parsed = YAML.parse(content);
    if (!isPlainObject(parsed)) {
      return errorResponse(400, {
        error: 'Spec file is not a valid YAML object',
        code: 'invalid_spec',
      });
    }

    assertSpecMatchesExpectedType(parsed, requestedType);
    return NextResponse.json({ scenario, name, yaml: content, spec: parsed });
  } catch (error) {
    if (error instanceof SpecTypeMismatchError) {
      return errorResponse(409, {
        error: `This surface only supports ${error.expected} specs.`,
        code: 'type_mismatch',
      });
    }
    if (isNodeErrnoException(error) && error.code === 'ENOENT') {
      return errorResponse(404, { error: 'Spec not found', code: 'spec_not_found' });
    }

    const message = error instanceof Error ? error.message : String(error);
    if (isKnownRequestError(message)) {
      return errorResponse(400, { error: message, code: 'invalid_request' });
    }

    logServerError('apps/explorer/api/entity-graph-specs:get', error, {
      scenario,
      specName: name,
      requestedType,
    });
    return errorResponse(500, {
      error: 'Failed to read spec',
      detail: 'The server could not load this spec. Retry once, then check the server log.',
      code: 'read_failed',
    });
  }
}

export async function PUT(request: Request, { params }: { params: Params }) {
  const { name } = await params;
  let requestedType: AllowedSpecType | null = null;
  let scenario: EntityGraphScenarioId = 'default';
  let tmpPath: string | null = null;

  try {
    requestedType = readRequestedSpecType(request);
    scenario = readRequestedScenario(request);
    assertValidSpecName(name);

    const raw = await request.json().catch(() => null);
    if (!isPlainObject(raw)) {
      return errorResponse(400, { error: 'JSON object required', code: 'invalid_request' });
    }
    if (!isPutSpecBody(raw)) {
      return errorResponse(400, {
        error: 'Body must include yaml string',
        code: 'invalid_request',
      });
    }
    const body = raw;
    if (Buffer.byteLength(body.yaml, 'utf8') > 200_000) {
      return errorResponse(400, {
        error: 'yaml too large (max 200KB)',
        code: 'payload_too_large',
      });
    }

    let parsed: unknown;
    try {
      parsed = YAML.parse(body.yaml);
    } catch (error) {
      return errorResponse(400, {
        error: 'Invalid YAML',
        detail: error instanceof Error ? error.message : String(error),
        code: 'invalid_yaml',
      });
    }

    if (!isPlainObject(parsed)) {
      return errorResponse(400, {
        error: 'Spec must be a YAML object',
        code: 'invalid_spec',
      });
    }

    const specType = (parsed as ParsedSpecEnvelope).type;
    if (!isAllowedSpecType(specType)) {
      return errorResponse(400, {
        error: `Unsupported spec type: ${String(specType)}. Allowed: ${ALLOWED_SPEC_TYPES.join(', ')}`,
        code: 'invalid_spec_type',
      });
    }
    if (requestedType !== null && specType !== requestedType) {
      return errorResponse(409, {
        error: `This surface only supports ${requestedType} specs.`,
        code: 'type_mismatch',
      });
    }

    let validatedSpec: unknown = parsed;
    if (specType === 'resolution') {
      const { ResolutionSpecSchema } = await import('@bobsled-inc/model-spec/schemas');
      const result = ResolutionSpecSchema.safeParse(parsed);
      if (!result.success) {
        return errorResponse(400, {
          error: 'Resolution spec validation failed',
          issues: result.error.issues,
          code: 'validation_failed',
        });
      }
      validatedSpec = result.data;
    }

    const file = specYamlPath(name, scenario);
    tmpPath = `${file}.${randomUUID()}.tmp`;
    await assertExistingSpecMatchesType(file, requestedType);
    await fs.writeFile(tmpPath, body.yaml, 'utf8');
    await fs.rename(tmpPath, file);

    return NextResponse.json({ scenario, name, ok: true, spec: validatedSpec });
  } catch (error) {
    if (tmpPath) {
      await fs.unlink(tmpPath).catch(() => {});
    }

    if (error instanceof SpecTypeMismatchError) {
      return errorResponse(409, {
        error: `This surface only supports ${error.expected} specs.`,
        code: 'type_mismatch',
      });
    }

    const message = error instanceof Error ? error.message : String(error);
    if (isKnownRequestError(message)) {
      return errorResponse(400, { error: message, code: 'invalid_request' });
    }

    logServerError('apps/explorer/api/entity-graph-specs:put', error, {
      scenario,
      specName: name,
      requestedType,
    });
    return errorResponse(500, {
      error: 'Failed to write spec',
      detail: 'The server could not persist this spec. Retry once, then check the server log.',
      code: 'write_failed',
    });
  }
}
