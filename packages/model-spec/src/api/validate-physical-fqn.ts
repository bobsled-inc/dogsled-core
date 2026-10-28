/**
 * Per-integration physical-FQN uniqueness check.
 *
 * Every derived model in a project resolves to a physical write target —
 * `database.schema.table` for warehouses with cross-database DDL,
 * `schema.table` otherwise. If two models on the **same integration**
 * resolve to the same normalized physical FQN, the runtime materializer
 * will silently clobber one with the other and downstream consumers
 * (NL2SQL, semantic models) will get inconsistent results depending on
 * deploy order.
 *
 * The collision key is `(integration_handle, normalized_fqn)`. Two
 * different integrations targeting the same FQN string (e.g. `snowflake`
 * with `PROD.PUBLIC.ORDERS` and `databricks` with `PROD.PUBLIC.ORDERS`,
 * or two Postgres connections both materializing `PUBLIC.ORDERS`) are
 * NOT a collision — they're different warehouses identified by
 * different connections. The connection is the implicit outer scope of
 * every FQN.
 *
 * Normalization: case-fold and strip identifier-quoting characters
 * (`"`, `` ` ``). This is the broadest common denominator across the
 * dialects Dogsled supports — Snowflake treats unquoted identifiers as
 * upper-case, Postgres as lower-case, but quoted identifiers preserve
 * case verbatim on both. For commit-time collision detection we don't
 * need dialect-aware identifier canonicalization; we just need to
 * recognize that `X.Y.ORDERS`, `"x"."y"."orders"`, and `x.y.orders`
 * refer to the same physical table within a single connection.
 */

import type { IntegrationCompileContext } from './integration-context.js';

/**
 * Stable machine-parseable error code for the collision error string. Downstream
 * consumers (host applications, agent tool-response parsers) match
 * on this prefix to identify the error class without parsing the human-readable
 * message body.
 */
export const PHYSICAL_FQN_COLLISION_ERROR_CODE = 'MODEL_SPEC_PHYSICAL_FQN_COLLISION' as const;

/**
 * One model participating in a physical-FQN collision. Lifted out of
 * `PhysicalFqnCollision.models`' inline object type so the structured-boundary
 * shape has a name shared between the collision payload and the collector's
 * internal entry list.
 */
export interface PhysicalFqnCollisionModel {
  integration: string;
  name: string;
  resolvedFqn: string;
}

export interface PhysicalFqnCollision {
  /** The integration handle these colliding models belong to. */
  integration: string;
  /** The normalized FQN that two or more models on this integration share. */
  fqn: string;
  /** The models that collide on this FQN, in declaration order. */
  models: PhysicalFqnCollisionModel[];
}

/**
 * Walks every model across every integration context and groups them by
 * `(integration_handle, normalized_fqn)`. Returns one
 * `PhysicalFqnCollision` per group that has more than one member.
 *
 * Cross-integration matches are intentionally NOT reported as collisions:
 * two integrations are two different connections, identified by different
 * warehouses (or different databases on the same warehouse server). A
 * `snowflake.A.B.C` model and a `databricks.A.B.C` model can legitimately
 * coexist; so can a `pg_prod.PUBLIC.ORDERS` and a `pg_analytics.PUBLIC.ORDERS`
 * model on two different Postgres connections.
 */
export function collectPhysicalFqnCollisions(
  perIntegration: ReadonlyArray<IntegrationCompileContext>
): PhysicalFqnCollision[] {
  type Entry = PhysicalFqnCollisionModel;
  // Key shape: `${integration_handle}\x00${normalized_fqn}` — the NUL
  // separator can't appear in either a Dogsled integration handle or a SQL
  // identifier, so it's a safe joiner that avoids accidental ambiguity
  // (e.g. an integration handle that contains a dot).
  const groups = new Map<string, Entry[]>();

  for (const ictx of perIntegration) {
    for (const node of ictx.orderedNodes) {
      const resolvedFqn = resolveModelFqn(ictx, node.name);
      if (!resolvedFqn) continue;
      const normalized = normalizePhysicalFqn(resolvedFqn);
      const key = `${ictx.integration.handle}\x00${normalized}`;
      const list = groups.get(key) ?? [];
      list.push({ integration: ictx.integration.handle, name: node.name, resolvedFqn });
      groups.set(key, list);
    }
  }

  const collisions: PhysicalFqnCollision[] = [];
  for (const models of groups.values()) {
    if (models.length > 1) {
      collisions.push({
        // Every entry in this bucket shares the integration handle and
        // normalized FQN by construction — pull the values off the first.
        integration: models[0]!.integration,
        fqn: normalizePhysicalFqn(models[0]!.resolvedFqn),
        models,
      });
    }
  }
  return collisions;
}

/**
 * Build an error string suitable for attaching to one model's
 * `ValidateModelResult.errors` array. Lists the OTHER models that share
 * its physical FQN so the user sees both sides of the collision from
 * either model's error output.
 */
export function formatFqnCollisionError(
  collision: PhysicalFqnCollision,
  selfIntegration: string,
  selfName: string
): string {
  const others = collision.models
    .filter((m) => !(m.integration === selfIntegration && m.name === selfName))
    .map((m) => `\`${m.integration}.${m.name}\``)
    .join(', ');
  return (
    `[${PHYSICAL_FQN_COLLISION_ERROR_CODE}] Physical FQN \`${collision.fqn}\` ` +
    `is also declared by ${others}. ` +
    `Two models cannot materialize to the same physical table — adjust ` +
    `\`target_schema\` / \`target_database\` on one of the models, or ` +
    `point them at different physical tables.`
  );
}

/**
 * Resolve a model name to its fully-qualified physical target by reading
 * the integration's prebuilt `modelReg` (constructed in
 * `buildIntegrationContext` — same logic the compiler uses to emit DDL).
 * Returns `undefined` when the model isn't registered, which lets callers
 * skip the entry rather than fail noisily.
 */
function resolveModelFqn(ictx: IntegrationCompileContext, modelName: string): string | undefined {
  return ictx.modelReg.get(modelName.toLowerCase());
}

/**
 * Case-fold + strip the standard identifier-quoting characters. Sufficient
 * to recognize `X.Y.ORDERS`, `"x"."y"."orders"`, and `x.y.orders` as the
 * same physical FQN. Dialect-specific edge cases (Postgres treating
 * `"X"` as case-preserving vs `x` as case-folding) are out of scope for
 * V1 — the loose normalization here matches the spirit of the check.
 */
export function normalizePhysicalFqn(fqn: string): string {
  return fqn.replace(/["`]/g, '').toLowerCase();
}
