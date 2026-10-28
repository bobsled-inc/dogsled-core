import * as fs from 'node:fs/promises';
import { NextResponse } from 'next/server';
import YAML from 'yaml';
import { isAllowedSpecType, type AllowedSpecType } from '@/lib/entity-graph-spec-types';
import { listSpecFiles, specYamlPath } from '@/lib/entity-graph-workspace';
import { isEntityGraphScenarioId, type EntityGraphScenarioId } from '@/lib/entity-graph-scenarios';

export const dynamic = 'force-dynamic';

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

export async function GET(request: Request) {
  let requestedType: AllowedSpecType | null;
  let scenario: EntityGraphScenarioId = 'default';
  try {
    requestedType = readRequestedSpecType(request);
    const rawScenario = new URL(request.url).searchParams.get('scenario');
    if (rawScenario !== null && !isEntityGraphScenarioId(rawScenario)) {
      throw new Error(`Unsupported scenario: ${rawScenario}`);
    }
    scenario = (rawScenario as EntityGraphScenarioId | null) ?? 'default';
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 }
    );
  }

  try {
    const names = await listSpecFiles(scenario);
    const specs = await Promise.all(
      names.map(async (name) => {
        try {
          const content = await fs.readFile(specYamlPath(name, scenario), 'utf8');
          const parsed = YAML.parse(content) as { type?: unknown } | null;
          if (!isAllowedSpecType(parsed?.type)) {
            return null;
          }
          return requestedType === null || parsed.type === requestedType ? name : null;
        } catch {
          return null;
        }
      })
    );

    return NextResponse.json({
      scenario,
      specs: specs.filter((name): name is string => name !== null),
    });
  } catch {
    return NextResponse.json({ error: 'Failed to list Entity Graph specs' }, { status: 500 });
  }
}
