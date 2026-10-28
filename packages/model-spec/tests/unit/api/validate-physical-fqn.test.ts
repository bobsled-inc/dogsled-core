/**
 * Unit tests for the per-integration physical-FQN uniqueness check.
 *
 * Tests target the pure-function surface of
 * `src/api/validate-physical-fqn.ts`. The full project-level wiring
 * (`validateProject` attaching collision errors to `ValidateModelResult`
 * arrays) is covered separately in the orchestrator's own tests so the
 * pure-function tests here stay focused on the normalization +
 * grouping contract.
 */

import { describe, expect, it } from 'vitest';

import {
  collectPhysicalFqnCollisions,
  formatFqnCollisionError,
  normalizePhysicalFqn,
  PHYSICAL_FQN_COLLISION_ERROR_CODE,
} from '../../../src/api/validate-physical-fqn.js';
import type { IntegrationCompileContext } from '../../../src/api/integration-context.js';
import type { DagNode, ModelRegistry } from '../../../src/compiler/index.js';

/**
 * Helper for building the minimal `IntegrationCompileContext` slice the
 * collector reads. `modelReg` is the primary surface — the collector
 * looks up `node.name.toLowerCase()` in this map to get the resolved
 * physical FQN. Other fields are stubbed because the collector ignores
 * them entirely.
 */
interface FixtureModel {
  name: string;
  resolvedFqn: string;
}

interface FixtureInput {
  handle: string;
  models: FixtureModel[];
}

function buildIctx(input: FixtureInput): IntegrationCompileContext {
  const modelReg: ModelRegistry = new Map();
  const orderedNodes: DagNode[] = [];
  for (const m of input.models) {
    modelReg.set(m.name.toLowerCase(), m.resolvedFqn);
    orderedNodes.push({ name: m.name } as unknown as DagNode);
  }
  return {
    dialect: 'snowflake',
    targetSchema: 'PUBLIC',
    integration: { handle: input.handle } as unknown as IntegrationCompileContext['integration'],
    modelReg,
    orderedNodes,
    registry: new Map(),
    entryRegistry: new Map(),
  };
}

describe('normalizePhysicalFqn', () => {
  it('case-folds identifiers', () => {
    expect(normalizePhysicalFqn('X.Y.ORDERS')).toBe('x.y.orders');
    expect(normalizePhysicalFqn('x.y.orders')).toBe('x.y.orders');
    expect(normalizePhysicalFqn('X.y.OrDeRs')).toBe('x.y.orders');
  });

  it('strips double-quote and backtick identifier quoting', () => {
    expect(normalizePhysicalFqn('"X"."Y"."ORDERS"')).toBe('x.y.orders');
    expect(normalizePhysicalFqn('`X`.`Y`.`ORDERS`')).toBe('x.y.orders');
    expect(normalizePhysicalFqn('"X".`Y`.ORDERS')).toBe('x.y.orders');
  });

  it('treats quoted and unquoted variants of the same FQN as equal', () => {
    expect(normalizePhysicalFqn('X.Y.ORDERS')).toBe(normalizePhysicalFqn('"x"."y"."orders"'));
  });

  it('preserves the part separator', () => {
    // Doesn't collapse the dots — `x.y.orders` and `x.yorders` must NOT
    // normalize to the same string.
    expect(normalizePhysicalFqn('X.Y.ORDERS')).not.toBe(normalizePhysicalFqn('X.YORDERS'));
  });
});

describe('collectPhysicalFqnCollisions', () => {
  it('returns no collisions when every model has a unique FQN', () => {
    const ictx = buildIctx({
      handle: 'snowflake',
      models: [
        { name: 'orders', resolvedFqn: 'PROD.PUBLIC.ORDERS' },
        { name: 'customers', resolvedFqn: 'PROD.PUBLIC.CUSTOMERS' },
      ],
    });
    expect(collectPhysicalFqnCollisions([ictx])).toEqual([]);
  });

  it('detects two models within one integration sharing a physical FQN', () => {
    const ictx = buildIctx({
      handle: 'snowflake',
      models: [
        { name: 'orders', resolvedFqn: 'PROD.PUBLIC.ORDERS' },
        // Different `name`, same physical target — the collision the
        // check exists to catch.
        { name: 'orders_alt', resolvedFqn: 'PROD.PUBLIC.ORDERS' },
      ],
    });
    const collisions = collectPhysicalFqnCollisions([ictx]);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.fqn).toBe('prod.public.orders');
    expect(collisions[0]?.models.map((m) => m.name).sort()).toEqual(['orders', 'orders_alt']);
  });

  it('does NOT report cross-integration matches as collisions', () => {
    // Two integrations targeting the same FQN string are two different
    // connections / warehouses — not a collision. `snowflake.A.B.C` and
    // `databricks.A.B.C` can coexist; two Postgres connections can each
    // have a `PUBLIC.ORDERS` table that materializes on different
    // physical servers.
    const pg = buildIctx({
      handle: 'pg_prod',
      models: [{ name: 'orders', resolvedFqn: 'public.orders' }],
    });
    const pg2 = buildIctx({
      handle: 'pg_analytics',
      models: [{ name: 'orders', resolvedFqn: 'PUBLIC.ORDERS' }],
    });
    expect(collectPhysicalFqnCollisions([pg, pg2])).toEqual([]);
  });

  it('does NOT cross-pollute when one integration has a collision and the other does not', () => {
    // `snowflake` has an internal collision (foo + bar both → A.B.C),
    // `databricks` legitimately also has A.B.C on a single model. The
    // databricks model must NOT appear in the snowflake collision's
    // `models` array.
    const snowflake = buildIctx({
      handle: 'snowflake',
      models: [
        { name: 'foo', resolvedFqn: 'A.B.C' },
        { name: 'bar', resolvedFqn: 'A.B.C' },
      ],
    });
    const databricks = buildIctx({
      handle: 'databricks',
      models: [{ name: 'baz', resolvedFqn: 'A.B.C' }],
    });
    const collisions = collectPhysicalFqnCollisions([snowflake, databricks]);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.integration).toBe('snowflake');
    expect(collisions[0]?.models.map((m) => m.name).sort()).toEqual(['bar', 'foo']);
    expect(collisions[0]?.models.every((m) => m.integration === 'snowflake')).toBe(true);
  });

  it('treats case-only and quoting-only differences as the same FQN', () => {
    const ictx = buildIctx({
      handle: 'snowflake',
      models: [
        { name: 'orders_quoted', resolvedFqn: '"X"."Y"."ORDERS"' },
        { name: 'orders_unquoted', resolvedFqn: 'X.Y.ORDERS' },
      ],
    });
    expect(collectPhysicalFqnCollisions([ictx])).toHaveLength(1);
  });

  it('skips models whose modelReg lookup returns undefined', () => {
    // Build an ictx where `orderedNodes` has a model the modelReg
    // doesn't know about (e.g. it was filtered out before compile).
    // The collector must silently skip the entry rather than crash.
    const ictx: IntegrationCompileContext = {
      ...buildIctx({
        handle: 'snowflake',
        models: [{ name: 'orders', resolvedFqn: 'PROD.PUBLIC.ORDERS' }],
      }),
    };
    ictx.orderedNodes = [
      ...ictx.orderedNodes,
      { name: 'phantom' } as unknown as DagNode, // not in modelReg
    ];
    expect(() => collectPhysicalFqnCollisions([ictx])).not.toThrow();
    // The known model is still listed (no false-positive collision).
    expect(collectPhysicalFqnCollisions([ictx])).toEqual([]);
  });
});

describe('formatFqnCollisionError', () => {
  it('lists OTHER colliding models, omitting `self`', () => {
    const ictx = buildIctx({
      handle: 'snowflake',
      models: [
        { name: 'a', resolvedFqn: 'PROD.PUBLIC.SHARED' },
        { name: 'b', resolvedFqn: 'PROD.PUBLIC.SHARED' },
        { name: 'c', resolvedFqn: 'PROD.PUBLIC.SHARED' },
      ],
    });
    const collision = collectPhysicalFqnCollisions([ictx])[0]!;

    // From `a`'s perspective: error mentions b and c, not a itself.
    const errA = formatFqnCollisionError(collision, 'snowflake', 'a');
    expect(errA).not.toContain('`snowflake.a`');
    expect(errA).toContain('`snowflake.b`');
    expect(errA).toContain('`snowflake.c`');
    expect(errA).toContain('prod.public.shared');
  });

  it('prefixes the error string with the stable error code so consumers can parse it', () => {
    // The `[MODEL_SPEC_PHYSICAL_FQN_COLLISION]` prefix lets downstream
    // consumers (host applications, agent tool-response parsers)
    // identify the error class without parsing the human-readable body.
    const ictx = buildIctx({
      handle: 'snowflake',
      models: [
        { name: 'a', resolvedFqn: 'PROD.PUBLIC.SHARED' },
        { name: 'b', resolvedFqn: 'PROD.PUBLIC.SHARED' },
      ],
    });
    const collision = collectPhysicalFqnCollisions([ictx])[0]!;
    const err = formatFqnCollisionError(collision, 'snowflake', 'a');
    expect(err.startsWith(`[${PHYSICAL_FQN_COLLISION_ERROR_CODE}]`)).toBe(true);
  });
});
