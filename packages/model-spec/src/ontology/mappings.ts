import type { ProjectIndex } from '@bobsled-inc/project-index';
import { BUILTIN_CONCEPTS, type OntologyCatalogEntry, type OntologyDiagnostic } from './catalog.js';
import type { OntologyDocument, OntologyMappingDocument } from './schema.js';

export function validateMapping(
  entry: OntologyCatalogEntry,
  mapping: OntologyMappingDocument,
  ontology: OntologyDocument,
  index: ProjectIndex,
  diagnostics: OntologyDiagnostic[]
): void {
  const report = (
    code: string,
    fieldPath: string,
    message: string,
    severity: 'error' | 'warning' = 'error'
  ) => diagnostics.push({ code, filePath: entry.path, fieldPath, severity, message });
  const concepts = new Map(ontology.ontology.map((c) => [c.concept, c]));
  const relationship = (concept: string, name: string) => {
    if (name.startsWith(`${concept}.`)) name = name.slice(concept.length + 1);
    const pending = [concept],
      seen = new Set<string>();
    while (pending.length) {
      const n = pending.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      const c = concepts.get(n);
      const found = c?.relationships?.find((r) => r.name === name);
      if (found) return found;
      pending.push(...(c?.extends ?? []));
    }
    return undefined;
  };
  const identifiers = (name: string): string[] => {
    const pending = [name],
      seen = new Set<string>(),
      result = new Set<string>();
    while (pending.length) {
      const next = pending.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      const concept = concepts.get(next);
      if (concept?.identify_by) concept.identify_by.forEach((id) => result.add(id));
      else pending.push(...(concept?.extends ?? []));
    }
    return [...result];
  };
  const expression = (value: unknown, path: string) => {
    if (typeof value !== 'string') return;
    const match = /^([\p{L}_][\p{L}\p{N}_]*)\.([\p{L}_][\p{L}\p{N}_]*)$/u.exec(value.trim());
    if (!match) {
      report(
        'expression_not_verified',
        path,
        'Only direct dataset.field expressions have complete reference checks; preserve this expression for review.',
        'warning'
      );
      return;
    }
    const model = mapping.semantic_model_ref.bindings?.datasets[match[1]!];
    if (!model) {
      report('unknown_dataset', path, `No binding for dataset ${match[1]}`);
      return;
    }
    const source = index.entries.find((e) => {
      const d = e.document as Record<string, unknown> | undefined;
      return (
        d &&
        (e.kind === 'source'
          ? `${String(d['connection'])}.${String(d['name'])}`
          : e.kind === 'model'
            ? d['name']
            : undefined) === model
      );
    })?.document as Record<string, unknown> | undefined;
    const columns =
      (source?.['schema'] as { columns?: { name: string }[] } | undefined)?.columns ??
      (source?.['columns'] as { name: string }[] | undefined);
    if (
      source &&
      (!Array.isArray(columns) ||
        columns.some((c) => !c || typeof c !== 'object' || typeof c.name !== 'string'))
    ) {
      report(
        'invalid_model_columns',
        path,
        'Bound model output columns must be a list of named columns.'
      );
      return;
    }
    if (source && !columns?.some((c) => c.name === match[2])) {
      report('unknown_field', path, `Unknown output field ${match[1]}.${match[2]}`);
    }
  };
  const object = (value: unknown, expected: string, path: string, referent = false): void => {
    const m = value as Record<string, unknown>;
    const concept = typeof m['concept'] === 'string' ? m['concept'] : expected;
    if (concept !== expected) {
      report('mapping_role', `${path}/concept`, `Expected role concept ${expected}`);
    }
    const c = concepts.get(concept);
    if (typeof m['expression'] === 'string') {
      expression(m['expression'], `${path}/expression`);
      const ids = identifiers(concept);
      const target =
        ids.length === 1 ? relationship(concept, ids[0]!)?.roles?.[0]?.concept : undefined;
      const simple =
        target &&
        (concepts.get(target)?.type === 'ValueType' ||
          (BUILTIN_CONCEPTS.has(target) && target !== 'Any'));
      if (c?.type === 'EntityType' && (referent || !simple)) {
        report(
          'compound_identifier',
          path,
          'An entity expression requires a simple identifier; supply referent mappings.'
        );
      }
    }
    const refs = m['referent_mappings'] as Record<string, unknown>[] | undefined;
    refs?.forEach((ref, i) => {
      const name = String(ref['relationship']);
      const r = relationship(concept, name);
      const rp = `${path}/referent_mappings/${i}`;
      if (!r || !identifiers(concept).some((id) => id === name || `${concept}.${id}` === name)) {
        report(
          'unknown_identifier',
          `${rp}/relationship`,
          `Unknown identifying relationship ${name}`
        );
      } else if (r.roles?.length !== 1) {
        report('identifier_roles', rp, 'A referent mapping must identify one target role.');
      } else object(ref, r.roles[0]!.concept, rp, true);
    });
    if (
      refs &&
      identifiers(concept).some(
        (name) =>
          !refs.some(
            (r) => r['relationship'] === name || r['relationship'] === `${concept}.${name}`
          )
      )
    ) {
      report(
        'missing_identifier',
        path,
        'Referent mappings must cover every identifying relationship.'
      );
    }
  };
  const link = (value: unknown, owner: string, path: string, previous: string[] = []): void => {
    const node = value as Record<string, unknown>;
    const om = node['object_mapping'] as Record<string, unknown>;
    const current =
      typeof om['concept'] === 'string' ? om['concept'] : previous.length === 0 ? owner : undefined;
    if (!current) {
      report(
        'missing_role_concept',
        `${path}/object_mapping/concept`,
        'Nested object mappings must name the role concept.'
      );
      return;
    }
    const tuple = [...previous, current];
    const name = node['relationship'];
    const r = typeof name === 'string' ? relationship(owner, name) : undefined;
    if (typeof name === 'string' && !r) {
      report(
        'unknown_relationship',
        `${path}/relationship`,
        `Unknown relationship ${owner}.${name}`
      );
    }
    object(om, current, `${path}/object_mapping`);
    if (r) {
      const roles = [owner, ...(r.roles ?? []).map((role) => role.concept)];
      if (roles.length !== tuple.length) {
        report('mapping_role_count', path, 'The mapping depth must equal the relationship arity.');
      } else if (roles.some((role, i) => role !== tuple[i])) {
        report(
          'mapping_role',
          path,
          'Mapped concepts must follow the declared relationship role order.'
        );
      }
    }
    ((node['children'] ?? []) as unknown[]).forEach((child, i) =>
      link(child, owner, `${path}/children/${i}`, tuple)
    );
  };
  mapping.concept_mappings.forEach((m, i) => {
    const name = String(m['concept']);
    (m['object_mappings'] as unknown[] | undefined)?.forEach((v, j) =>
      object(v, name, `/concept_mappings/${i}/object_mappings/${j}`)
    );
    (m['link_mappings'] as unknown[] | undefined)?.forEach((v, j) =>
      link(v, name, `/concept_mappings/${i}/link_mappings/${j}`)
    );
  });
}
