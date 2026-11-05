import type { OntologyCatalog } from '@bobsled-inc/model-spec/ontology';
import { CommandError } from '@bobsled-inc/protocol';

export interface CustomerOntologyReference {
  ontology: string;
  concept: string;
  relationship: string;
  left_concept: string;
  right_concept: string;
}
export function resolveCustomerOntologyReference(
  catalog: OntologyCatalog,
  ref: CustomerOntologyReference,
  cardinality?: string
) {
  const entries = catalog.entries.filter(
    (e) => e.document.type === 'ontology' && e.document.name === ref.ontology
  );
  if (
    entries.length !== 1 ||
    catalog.diagnostics.some((d) => d.severity === 'error' && d.filePath === entries[0]?.path)
  ) {
    throw new CommandError('Customer ontology reference must resolve to one valid ontology.', 2);
  }
  const doc = entries[0]!.document;
  if (doc.type !== 'ontology') throw new CommandError('Expected an ontology.', 2);
  const concept = doc.ontology.find((c) => c.concept === ref.concept);
  const relation = concept?.relationships?.find((r) => r.name === ref.relationship);
  if (!concept || !relation) throw new CommandError('Unknown customer ontology relationship.', 2);
  if (relation.roles?.length !== 1 || relation.derived_by?.length || concept.derived_by?.length) {
    throw new CommandError(
      'Relationship extraction requires a binary, non-derived relationship.',
      2
    );
  }
  if (ref.left_concept !== concept.concept || ref.right_concept !== relation.roles[0]!.concept) {
    throw new CommandError('Extraction role bindings conflict with the customer ontology.', 2);
  }
  if (
    (relation.multiplicity === 'OneToOne' && cardinality && cardinality !== 'one_to_one') ||
    (relation.multiplicity === 'ManyToOne' &&
      cardinality &&
      !['many_to_one', 'one_to_one'].includes(cardinality))
  ) {
    throw new CommandError('Extraction cardinality conflicts with ontology multiplicity.', 2);
  }
  return {
    description: relation.description ?? relation.verbalizes.join(' '),
    leftConcept: concept.concept,
    rightConcept: relation.roles[0]!.concept,
  };
}
