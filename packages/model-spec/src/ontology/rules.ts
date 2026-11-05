import type { OntologyConcept, OntologyDocument, OntologyRelationship } from './schema.js';
import { parseRule, RuleIssue, unsupported, type RuleExpression } from './rule-parser.js';
import { BUILTIN_CONCEPTS } from './catalog.js';

type Result = { type: string; references: Set<string> };
type Report = (code: string, path: string, message: string, severity?: 'error' | 'warning') => void;
const fail = (code: string, message: string): never => {
  throw new RuleIssue(code, message);
};

export function validateOntologyRules(document: OntologyDocument, report: Report) {
  const concepts = new Map(document.ontology.map((c) => [c.concept, c]));
  const parents = (name: string): Set<string> => {
    const result = new Set<string>(),
      pending = [name];
    while (pending.length) {
      const n = pending.pop()!;
      if (result.has(n)) continue;
      result.add(n);
      const c = concepts.get(n);
      pending.push(...(c?.extends ?? []));
      if (c?.type === 'EntityType') result.add('Any');
    }
    return result;
  };
  const compatible = (actual: string, expected: string) => {
    const a = parents(actual),
      b = parents(expected);
    const numeric = ['Integer', 'Decimal', 'Float'];
    return a.has(expected) || (numeric.some((n) => a.has(n)) && numeric.some((n) => b.has(n)));
  };
  const relationship = (owner: string, name: string) => {
    for (const n of parents(owner)) {
      const r = concepts.get(n)?.relationships?.find((r) => r.name === name);
      if (r) return r;
    }
    return undefined;
  };
  const check = (
    text: string,
    path: string,
    concept?: OntologyConcept,
    relation?: OntologyRelationship,
    derived = false
  ) => {
    try {
      const roles = new Map<string, string>();
      if (concept) roles.set(concept.concept, concept.concept);
      relation?.roles?.forEach((role) => roles.set(role.name ?? role.concept, role.concept));
      const evaluate = (node: RuleExpression): Result => {
        if (node.kind === 'literal') return { type: node.type, references: new Set() };
        if (node.kind === 'unary') {
          const value = evaluate(node.value);
          if (node.operator === 'NOT' && !compatible(value.type, 'Boolean')) {
            fail('expression_type', 'NOT requires a boolean expression.');
          }
          return { ...value, type: 'Boolean' };
        }
        if (node.kind === 'binary') {
          const a = evaluate(node.left),
            b = evaluate(node.right);
          if (node.operator === 'AND' || node.operator === 'OR') {
            if (!compatible(a.type, 'Boolean') || !compatible(b.type, 'Boolean')) {
              fail('expression_type', 'Boolean operators require boolean expressions.');
            }
          } else if (!compatible(a.type, b.type) && !compatible(b.type, a.type)) {
            fail('expression_type', `Cannot compare ${a.type} and ${b.type}.`);
          }
          return { type: 'Boolean', references: new Set([...a.references, ...b.references]) };
        }
        const first = node.parts[0]!;
        if (node.args && node.parts.length === 1) {
          unsupported('Function calls outside documented ontology navigation are not verified.');
        }
        let type = roles.get(first) ?? first;
        if (!concepts.has(type) && !BUILTIN_CONCEPTS.has(type)) {
          fail('expression_reference', `Unknown concept or role ${first}.`);
        }
        const references = new Set([first]);
        for (let i = 1; i < node.parts.length; i++) {
          const name = node.parts[i]!;
          const r = relationship(type, name);
          if (!r) fail('expression_reference', `Unknown relationship ${type}.${name}.`);
          const targets = r!.roles ?? [];
          const last = i === node.parts.length - 1;
          if (last && node.args) {
            if (targets.length !== node.args.length) {
              fail(
                'expression_arity',
                `Relationship ${type}.${name} expects ${targets.length} role arguments.`
              );
            }
            node.args.forEach((arg, j) => {
              const value = evaluate(arg);
              if (!compatible(value.type, targets[j]!.concept)) {
                fail('expression_type', `Expected ${targets[j]!.concept}, received ${value.type}.`);
              }
              value.references.forEach((ref) => references.add(ref));
            });
            type = 'Boolean';
          } else if (targets.length === 1) type = targets[0]!.concept;
          else if (targets.length === 0 && last) type = 'Boolean';
          else {
            unsupported(
              'Navigation over multiple remaining roles requires explicit role arguments.'
            );
          }
        }
        return { type, references };
      };
      const result = evaluate(parseRule(text));
      if (relation && derived) {
        const names = [...roles.keys()];
        const last = names.at(-1)!;
        const missing = names.filter(
          (name) =>
            !result.references.has(name) &&
            !(name === last && compatible(result.type, roles.get(name)!))
        );
        if (missing.length) {
          fail('expression_scope', `Derivation does not bind roles: ${missing.join(', ')}.`);
        }
      } else if (
        concept &&
        !derived &&
        ![...roles.keys()].some((name) => result.references.has(name))
      ) {
        fail('expression_scope', 'A constraint must reference its concept or a relationship role.');
      } else if (concept && derived && !relation) {
        // A subtype derivation selects from its parent population, or names the derived concept.
        if (![...result.references].some((name) => parents(concept.concept).has(name))) {
          fail('expression_scope', 'A concept derivation must reference its concept or a parent.');
        }
      }
    } catch (error) {
      if (!(error instanceof RuleIssue)) throw error;
      report(
        error.code,
        path,
        error.message,
        error.code === 'expression_not_verified' ? 'warning' : 'error'
      );
    }
  };
  document.requires?.forEach((rule, i) => check(rule, `/requires/${i}`));
  document.ontology.forEach((concept, i) => {
    const base = `/ontology/${i}`;
    concept.requires?.forEach((rule, j) => check(rule, `${base}/requires/${j}`, concept));
    concept.derived_by?.forEach((rule, j) =>
      check(rule, `${base}/derived_by/${j}`, concept, undefined, true)
    );
    concept.relationships?.forEach((relation, j) => {
      relation.requires?.forEach((rule, k) =>
        check(rule, `${base}/relationships/${j}/requires/${k}`, concept, relation)
      );
      relation.derived_by?.forEach((rule, k) =>
        check(rule, `${base}/relationships/${j}/derived_by/${k}`, concept, relation, true)
      );
    });
  });
}
