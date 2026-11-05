import { boundOntologyItems } from './bounds.js';
import { CommandError } from '../errors.js';
import type { OntologyCatalog } from './catalog.js';
import type { OntologyConcept } from './schema.js';

export function getOntologyContext(
  catalog: OntologyCatalog,
  request: { ontology?: string; concept?: string; limit?: number } = {}
) {
  const limit = request.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new CommandError('Ontology limit must be an integer from 1 to 200.', 2);
  }
  const entries = catalog.entries.filter(
    (e) =>
      e.document.type === 'ontology' && (!request.ontology || e.document.name === request.ontology)
  );
  if (
    catalog.diagnostics.some(
      (d) => d.code === 'duplicate_identity' && entries.some((e) => e.path === d.filePath)
    )
  ) {
    throw new CommandError('Ambiguous ontology identity.', 2);
  }
  const concepts = entries.flatMap((entry) => {
    if (entry.document.type !== 'ontology') return [];
    const all = entry.document.ontology;
    if (!request.concept) return all.map((c) => ({ ...c, ontology: entry.document.name }));
    const pending = all.filter((c) => c.concept === request.concept);
    const selected: OntologyConcept[] = [];
    const seen = new Set<string>();
    while (pending.length) {
      const concept = pending.shift()!;
      if (seen.has(concept.concept)) continue;
      seen.add(concept.concept);
      selected.push(concept);
      const references = [
        ...(concept.extends ?? []),
        ...(concept.relationships ?? []).flatMap((r) =>
          (r.roles ?? []).map((role) => role.concept)
        ),
      ];
      pending.push(...all.filter((c) => references.includes(c.concept)));
    }
    return selected.map((c) => ({ ...c, ontology: entry.document.name }));
  });
  const selected = boundOntologyItems(concepts, limit);
  const mappings = boundOntologyItems(
    catalog.entries.filter(
      (e) =>
        e.document.type === 'ontology_mapping' &&
        (!request.ontology || e.document.ontology_ref.name === request.ontology)
    ),
    limit
  );
  const roots = boundOntologyItems(
    entries.map((e) => ({
      name: e.document.name,
      sourceHash: e.sourceHash,
      sourcePath: e.path,
      description: e.document['description'],
      requires: e.document['requires'],
      prefixes: e.document['prefixes'],
      ai_context: e.document['ai_context'],
    })),
    limit
  );
  const diagnostics = boundOntologyItems(catalog.diagnostics, 200, 100_000);
  return {
    version: catalog.version,
    sourcePaths: roots.items.map((e) => e.sourcePath),
    ontologies: roots.items,
    concepts: selected.items,
    omitted: selected.omitted.map((c) => c.concept),
    omittedReferences: selected.omitted.map((c) => ({ ontology: c.ontology, concept: c.concept })),
    omittedCount: selected.omittedCount,
    omittedOntologies: roots.omitted.map((e) => e.name),
    omittedMappings: mappings.omitted.map((e) => e.document.name),
    truncated: selected.truncated || mappings.truncated || roots.truncated || diagnostics.truncated,
    mappings: mappings.items,
    diagnostics: diagnostics.items,
    diagnosticCount: catalog.diagnostics.length,
  };
}
