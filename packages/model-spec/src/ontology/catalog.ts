import { validateMapping } from './mappings.js';
import { createHash } from 'node:crypto';
import { assertCompleteProjectIndex, type ProjectIndex } from '@bobsled-inc/project-index';
import {
  parseOntologyDocument,
  type OntologyFile,
  type OntologyDocument,
  type OntologyConcept,
} from './schema.js';

export interface OntologyDiagnostic {
  code: string;
  filePath: string;
  fieldPath: string;
  severity: 'error' | 'warning';
  message: string;
}
export interface OntologyCatalogEntry {
  path: string;
  sourceHash: string;
  document: OntologyFile;
}
export interface OntologyCatalog {
  entries: OntologyCatalogEntry[];
  diagnostics: OntologyDiagnostic[];
  version: string;
}
export const BUILTIN_CONCEPTS = new Set([
  'Any',
  'Boolean',
  'Date',
  'DateTime',
  'Decimal',
  'Float',
  'Integer',
  'String',
]);

export function loadOntologyCatalog(index: ProjectIndex): OntologyCatalog {
  assertCompleteProjectIndex(index);
  const entries: OntologyCatalogEntry[] = [];
  const diagnostics: OntologyDiagnostic[] = [];
  for (const issue of index.issues) {
    if (
      issue.declaredType === 'ontology' ||
      issue.declaredType === 'ontology_mapping' ||
      issue.code === 'symlink'
    ) {
      diagnostics.push({
        code: issue.code,
        filePath: issue.path,
        fieldPath: '/',
        severity: 'error',
        message: issue.message,
      });
    }
  }
  for (const entry of index.entries) {
    if (entry.kind !== 'ontology' && entry.kind !== 'ontology_mapping') continue;
    try {
      entries.push({
        path: entry.path,
        sourceHash: createHash('sha256').update(entry.content).digest('hex'),
        document: parseOntologyDocument(entry.document),
      });
    } catch (error) {
      diagnostics.push({
        code: 'ontology_schema',
        filePath: entry.path,
        fieldPath: '/',
        severity: 'error',
        message: error instanceof Error ? error.message : 'Invalid ontology document',
      });
    }
  }
  const catalog: OntologyCatalog = {
    entries,
    diagnostics,
    version: createHash('sha256')
      .update(JSON.stringify(entries.map((e) => [e.path, e.sourceHash])))
      .digest('hex'),
  };
  const identities = new Map<string, string>();
  for (const entry of entries) {
    const key = `${entry.document.type}:${entry.document.name}`;
    const prior = identities.get(key);
    if (prior) {
      diagnostics.push({
        code: 'duplicate_identity',
        filePath: entry.path,
        fieldPath: '/name',
        severity: 'error',
        message: `Duplicate identity also declared in ${prior}`,
      });
    }
    identities.set(key, entry.path);
    if (entry.document.type === 'ontology') validateDefinition(entry, entry.document, diagnostics);
  }
  const scopes = new Map<string, string>();
  for (const entry of entries) {
    if (entry.document.type !== 'ontology_mapping') continue;
    const mapping = entry.document;
    const report = (code: string, fieldPath: string, message: string) =>
      diagnostics.push({
        code,
        filePath: entry.path,
        fieldPath,
        severity: 'error' as const,
        message,
      });
    const ontology = entries.find(
      (e) => e.document.type === 'ontology' && e.document.name === mapping.ontology_ref.name
    )?.document;
    if (!ontology || ontology.type !== 'ontology') {
      report(
        'unknown_ontology',
        '/ontology_ref/name',
        `Unknown ontology ${mapping.ontology_ref.name}`
      );
    }
    const bindings = mapping.semantic_model_ref.bindings;
    const scope = mapping.semantic_model_ref.name;
    const signature = JSON.stringify(bindings, (_key, value: unknown) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
        : value
    );
    if (scopes.has(scope) && scopes.get(scope) !== signature) {
      report(
        'conflicting_scope',
        '/semantic_model_ref/bindings',
        `Conflicting bindings for ${scope}`
      );
    }
    scopes.set(scope, signature);
    if (!bindings) {
      report(
        'unresolved_mapping',
        '/semantic_model_ref/bindings',
        'Supply explicit model bindings to complete this mapping.'
      );
    }
    for (const [alias, model] of Object.entries(bindings?.datasets ?? {})) {
      const candidates = index.entries.filter((e) => {
        if (e.kind !== 'model' && e.kind !== 'source') return false;
        const d = e.document as Record<string, unknown> | undefined;
        return (
          d &&
          (e.kind === 'source' ? `${String(d['connection'])}.${String(d['name'])}` : d['name']) ===
            model
        );
      });
      if (candidates.length !== 1) {
        report(
          'unresolved_dataset',
          `/semantic_model_ref/bindings/datasets/${alias}`,
          `Expected one model for ${model}`
        );
      }
    }
    for (const [field, kind] of [
      ['relationships', 'relationship'],
      ['metrics', 'metric'],
      ['verified_queries', 'vq'],
    ] as const) {
      for (const name of bindings?.[field] ?? []) {
        if (
          index.entries.filter(
            (e) => e.kind === kind && (e.document as Record<string, unknown>)?.['name'] === name
          ).length !== 1
        ) {
          report(
            'unresolved_binding',
            `/semantic_model_ref/bindings/${field}`,
            `Expected one ${kind} named ${name}`
          );
        }
      }
    }
    if (ontology?.type === 'ontology') {
      validateMapping(entry, mapping, ontology, index, diagnostics);
      mapping.concept_mappings.forEach((m, i) => {
        const concept = ontology.ontology.find((c) => c.concept === m['concept']);
        if (!concept) {
          report(
            'unknown_concept',
            `/concept_mappings/${i}/concept`,
            `Unknown concept ${String(m['concept'])}`
          );
        } else if (m['object_mappings'] && concept.type !== 'EntityType') {
          report(
            'invalid_object_mapping',
            `/concept_mappings/${i}/object_mappings`,
            'Object mappings require an entity type.'
          );
        }
      });
    }
  }
  return catalog;
}

function validateDefinition(
  entry: OntologyCatalogEntry,
  document: OntologyDocument,
  diagnostics: OntologyDiagnostic[]
): void {
  const report = (
    code: string,
    fieldPath: string,
    message: string,
    severity: 'error' | 'warning' = 'error'
  ) => diagnostics.push({ code, filePath: entry.path, fieldPath, severity, message });
  const concepts = new Map<string, OntologyConcept>();
  document.ontology.forEach((c, i) => {
    if (concepts.has(c.concept) || BUILTIN_CONCEPTS.has(c.concept)) {
      report(
        'duplicate_concept',
        `/ontology/${i}/concept`,
        `Concept ${c.concept} is already defined.`
      );
    }
    concepts.set(c.concept, c);
  });
  const kind = (name: string) =>
    BUILTIN_CONCEPTS.has(name)
      ? name === 'Any'
        ? 'EntityType'
        : 'ValueType'
      : concepts.get(name)?.type;
  const ancestors = (name: string, seen = new Set<string>()): Set<string> => {
    const pending = [name];
    while (pending.length) {
      const current = pending.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      pending.push(...(concepts.get(current)?.extends ?? []));
    }
    return seen;
  };
  document.ontology.forEach((c, i) => {
    const base = `/ontology/${i}`;
    const checkIri = (iri: string | undefined, fieldPath: string) => {
      if (!iri) return;
      if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(iri) || /^(urn|mailto):/iu.test(iri)) return;
      const prefix = iri.split(':')[0]!;
      if (!iri.includes(':') || !document.prefixes?.[prefix]) {
        report('unknown_prefix', fieldPath, `Undeclared IRI prefix ${prefix}`);
      }
    };
    checkIri(c.iri, `${base}/iri`);
    c.relationships?.forEach((r, j) => checkIri(r.iri, `${base}/relationships/${j}/iri`));
    (c.extends ?? []).forEach((parent, p) => {
      if (!kind(parent)) {
        report('unknown_concept', `${base}/extends/${p}`, `Unknown concept ${parent}`);
      } else if (kind(parent) !== c.type) {
        report(
          'inheritance_kind',
          `${base}/extends/${p}`,
          'Parent and child must have the same concept type.'
        );
      }
      if (ancestors(parent).has(c.concept)) {
        report('inheritance_cycle', `${base}/extends/${p}`, 'Inheritance contains a cycle.');
      }
    });
    if (
      c.type === 'ValueType' &&
      ![...ancestors(c.concept)].some((n) => BUILTIN_CONCEPTS.has(n) && n !== 'Any')
    ) {
      report(
        'value_type_parent',
        `${base}/extends`,
        'A value type must extend a built-in value type.'
      );
    }
    const relationshipNames = new Map<string, number>();
    for (const name of ancestors(c.concept)) {
      for (const r of concepts.get(name)?.relationships ?? []) {
        relationshipNames.set(r.name, r.roles?.length ?? 0);
      }
    }
    c.identify_by?.forEach((name, j) => {
      if (!relationshipNames.has(name)) {
        report(
          'unknown_identifier',
          `${base}/identify_by/${j}`,
          `Unknown identifying relationship ${name}`
        );
      } else if (relationshipNames.get(name) !== 1) {
        report(
          'invalid_identifier',
          `${base}/identify_by/${j}`,
          'Identifying relationships must be binary.'
        );
      }
    });
    const local = new Set<string>();
    c.relationships?.forEach((r, j) => {
      const rb = `${base}/relationships/${j}`;
      if (local.has(r.name)) {
        report('duplicate_relationship', `${rb}/name`, `Duplicate relationship ${r.name}`);
      }
      local.add(r.name);
      if (r.multiplicity === 'OneToOne' && r.roles?.length !== 1) {
        report(
          'invalid_multiplicity',
          `${rb}/multiplicity`,
          'OneToOne applies only to binary relationships.'
        );
      }
      const roles = new Set([c.concept]);
      const verbalRoles = new Set([c.concept]);
      r.roles?.forEach((role, k) => {
        if (!kind(role.concept)) {
          report('unknown_concept', `${rb}/roles/${k}/concept`, `Unknown concept ${role.concept}`);
        }
        const name = role.name ?? role.concept;
        if (roles.has(name)) {
          report(
            'ambiguous_role',
            `${rb}/roles/${k}`,
            'Repeated concepts need distinct role names.'
          );
        }
        roles.add(name);
        verbalRoles.add(role.name ? `${role.concept}:${role.name}` : role.concept);
      });
      r.verbalizes.forEach((v, k) => {
        for (const m of v.matchAll(/\{([^}]+)\}/gu)) {
          if (!verbalRoles.has(m[1]!)) {
            report('unknown_role', `${rb}/verbalizes/${k}`, `Unknown role ${m[1]}`);
          }
        }
      });
    });
  });
  // Do not execute expressions or confuse a parsed string with a verified business rule.
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}/${i}`));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, v] of Object.entries(value)) {
      if ((key === 'requires' || key === 'derived_by') && Array.isArray(v)) {
        v.forEach((_, i) =>
          report(
            'expression_not_verified',
            `${path}/${key}/${i}`,
            'Rule text is preserved as context. Its expression semantics have not been verified.',
            'warning'
          )
        );
      } else walk(v, `${path}/${key}`);
    }
  };
  walk(document, '');
}
