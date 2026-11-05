import type { ProjectIndex } from '@bobsled-inc/project-index';
import type { OntologyCatalog } from './catalog.js';

/** Read only the shared reference; extraction settings remain owned by Entity Graph. */
export function extractionReferences(index: ProjectIndex) {
  return index.entries.flatMap((entry) => {
    if (entry.kind !== 'relationship_ontology') return [];
    const doc = entry.document as { relations?: unknown };
    if (!Array.isArray(doc.relations)) return [];
    return doc.relations.flatMap((relation: unknown, i) => {
      if (!relation || typeof relation !== 'object' || !('ontology_ref' in relation)) return [];
      const ref = relation.ontology_ref;
      if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return [];
      return [
        {
          path: entry.path,
          fieldPath: `/relations/${i}/ontology_ref`,
          ref: ref as Record<string, unknown>,
        },
      ];
    });
  });
}

export function validateExtractionReferences(index: ProjectIndex, catalog: OntologyCatalog) {
  for (const { path, fieldPath, ref } of extractionReferences(index)) {
    const matches = catalog.entries.filter(
      (e) => e.document.type === 'ontology' && e.document.name === ref['ontology']
    );
    const doc = matches.length === 1 ? matches[0]!.document : undefined;
    const concept =
      doc?.type === 'ontology' ? doc.ontology.find((c) => c.concept === ref['concept']) : undefined;
    const relationship = concept?.relationships?.find((r) => r.name === ref['relationship']);
    const code = !doc
      ? 'unknown_ontology'
      : !concept
        ? 'unknown_concept'
        : !relationship
          ? 'unknown_relationship'
          : undefined;
    if (code) {
      catalog.diagnostics.push({
        code,
        filePath: path,
        fieldPath,
        severity: 'error',
        message: 'Extraction reference must resolve to one ontology, concept, and relationship.',
      });
    }
  }
}
