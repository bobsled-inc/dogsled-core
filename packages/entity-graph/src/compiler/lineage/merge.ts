import type { ResolvedResolutionSpec } from '../identity/types.js';
import type { ResolvedSurvivorshipSpec } from '../survivorship/types.js';
import type { LineageRow } from './types.js';

/**
 * Derive schema-level lineage rows from resolution + survivorship specs.
 *
 * For each survivorship attribute rule, find the matching resolution inputs by
 * source-system alias and emit one provenance row per (attribute, source). The
 * source column is the same field name used in the standardize step — the
 * resolution pipeline never renames fields, it only applies transforms.
 *
 * Rows are schema-level (entity_id = null). Instance-level lineage (which
 * entity got a value from which specific record) is a future extension.
 */
export function buildLineageRows(
  resolutionSpec: ResolvedResolutionSpec,
  survivorshipSpec: ResolvedSurvivorshipSpec
): { rows: LineageRow[]; warnings: string[] } {
  const rows: LineageRow[] = [];
  const warnings: string[] = [];

  const entityType = survivorshipSpec.entity;
  const profileTable = `${entityType}__entity_profile`;

  // Build a quick lookup: source alias → fully-qualified table name
  const tableByAlias = new Map<string, string>();
  for (const input of resolutionSpec.inputs) {
    tableByAlias.set(input.alias, input.fqTableName);
  }

  // Build a lookup: standardize field → transform functions
  const standardizeByField = new Map<string, string[]>();
  for (const st of resolutionSpec.standardize) {
    standardizeByField.set(st.field, st.transforms);
  }

  // Build a lookup: profile field → output alias
  const profileAliasByField = new Map<string, string>();
  for (const attr of resolutionSpec.profile?.attributes ?? []) {
    profileAliasByField.set(attr.field, attr.alias);
  }

  for (const rule of survivorshipSpec.attributeRules) {
    const attribute = rule.attribute;
    const profileColumn = profileAliasByField.get(attribute) ?? attribute;
    const transforms = standardizeByField.get(attribute);
    const transformRef = transforms && transforms.length > 0 ? transforms.join(',') : null;
    const transformStep = transforms && transforms.length > 0 ? 'standardize' : null;

    if (rule.sourceOrder.length === 0) {
      // No sources — emit a single incomplete row so the gap is visible
      rows.push({
        entity_type: entityType,
        entity_id: null,
        attribute,
        profile_table: profileTable,
        profile_column: profileColumn,
        source_system: null,
        source_table: '',
        source_column: attribute,
        field_path: null,
        transform_ref: transformRef,
        transform_step: transformStep,
        is_complete: false,
      });
      warnings.push(
        `${entityType}.${attribute}: no source systems declared in survivorship rule — lineage is incomplete`
      );
      continue;
    }

    for (const sourceAlias of rule.sourceOrder) {
      const sourceTable = tableByAlias.get(sourceAlias);
      if (sourceTable === undefined) {
        rows.push({
          entity_type: entityType,
          entity_id: null,
          attribute,
          profile_table: profileTable,
          profile_column: profileColumn,
          source_system: sourceAlias,
          source_table: '',
          source_column: attribute,
          field_path: null,
          transform_ref: transformRef,
          transform_step: transformStep,
          is_complete: false,
        });
        warnings.push(
          `${entityType}.${attribute}: source system '${sourceAlias}' not found in resolution inputs — lineage is incomplete`
        );
        continue;
      }

      rows.push({
        entity_type: entityType,
        entity_id: null,
        attribute,
        profile_table: profileTable,
        profile_column: profileColumn,
        source_system: sourceAlias,
        source_table: sourceTable,
        source_column: attribute,
        field_path: null,
        transform_ref: transformRef,
        transform_step: transformStep,
        is_complete: true,
      });
    }
  }

  return { rows, warnings };
}
