import { z } from 'zod';

/**
 * Per-reference read mode for a mixed (live-rooted) `on_read` model's
 * warehouse-materialized leaf. It rides on a transform *reference* (the primary
 * `source`, a `joins[]` entry, or a `union[]` branch) because the choice is the
 * consuming mixed model's, per reference — the same warehouse model may be read
 * `live` by one mixed model and `lazy` by another.
 *
 *  - `live` — read the leaf fresh at query time (capped).
 *  - `lazy` — reuse a snapshot cached in the engine within `max_age`.
 *
 * This is **authoring metadata only**: model-spec accepts, types, and carries
 * `read_mode` but never acts on it during compilation (the emitted SQL, DAG,
 * and materialization are unaffected). The host query runtime
 * reads `read_mode` off the parsed spec and drives
 * `materializeWarehouseLeaf({ mode })`. model-spec deliberately does not police
 * where the field is meaningful (that needs cross-model root analysis it does
 * not own); it is silently ignored everywhere it does not apply.
 *
 * Named `read_mode` (not `mode`) to disambiguate from a source spec's
 * `mode: live | lazy | extract` (an `api_resource` *extraction* mode).
 */
export const ReadModeSchema = z
  .enum(['live', 'lazy'])
  .optional()
  .describe(
    'How a mixed (live-rooted) model reads this warehouse-materialized leaf: ' +
      "'live' = fresh read at query time (capped); 'lazy' = cached in the engine " +
      'within max_age. Ignored for non-mixed models and non-warehouse refs.'
  );

/** The per-reference read mode (`live` | `lazy`), or undefined when unset. */
export type ReadMode = z.infer<typeof ReadModeSchema>;
