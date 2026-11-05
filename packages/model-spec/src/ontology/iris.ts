import type { OntologyDocument } from './schema.js';

// RFC 3987 ucschar ranges. Private-use characters are only allowed in a query.
const unicode =
  '\\u00A0-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFEF\\u{10000}-\\u{1FFFD}\\u{20000}-\\u{2FFFD}\\u{30000}-\\u{3FFFD}\\u{40000}-\\u{4FFFD}\\u{50000}-\\u{5FFFD}\\u{60000}-\\u{6FFFD}\\u{70000}-\\u{7FFFD}\\u{80000}-\\u{8FFFD}\\u{90000}-\\u{9FFFD}\\u{A0000}-\\u{AFFFD}\\u{B0000}-\\u{BFFFD}\\u{C0000}-\\u{CFFFD}\\u{D0000}-\\u{DFFFD}\\u{E1000}-\\u{EFFFD}';
const chars = `A-Za-z0-9._~!$&'()*+,;=:@%${unicode}`;
const authorityPattern = new RegExp(`^[${chars}\\[\\]]*$`, 'u');
const pathPattern = new RegExp(`^[${chars}/]*$`, 'u');
const queryPattern = new RegExp(
  `^[${chars}/?\\uE000-\\uF8FF\\u{F0000}-\\u{FFFFD}\\u{100000}-\\u{10FFFD}]*$`,
  'u'
);
const fragmentPattern = new RegExp(`^[${chars}/?]*$`, 'u');
function absoluteIri(value: string): boolean {
  if (/%(?![0-9a-f]{2})/iu.test(value)) return false;
  const match = /^([a-z][a-z0-9+.-]*):([^?#]+)(?:\?([^#]*))?(?:#(.*))?$/iu.exec(value);
  if (!match) return false;
  let path = match[2]!;
  if (path.startsWith('//')) {
    const end = path.indexOf('/', 2);
    const authority = end === -1 ? path.slice(2) : path.slice(2, end);
    if (!authorityPattern.test(authority)) return false;
    path = end === -1 ? '' : path.slice(end);
  }
  if (
    !pathPattern.test(path) ||
    !queryPattern.test(match[3] ?? '') ||
    !fragmentPattern.test(match[4] ?? '')
  ) {
    return false;
  }
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

export function validateOntologyIris(
  document: OntologyDocument,
  report: (code: string, fieldPath: string, message: string) => void
) {
  for (const [prefix, iri] of Object.entries(document.prefixes ?? {})) {
    if (!/^[\p{L}_][\p{L}\p{N}_.-]*$/u.test(prefix) || !absoluteIri(iri)) {
      report(
        'invalid_iri',
        `/prefixes/${prefix}`,
        'Namespace prefixes must name a valid absolute IRI.'
      );
    }
  }
  const check = (iri: string | undefined, path: string) => {
    if (iri === undefined) return;
    const colon = iri.indexOf(':');
    const prefix = iri.slice(0, colon);
    if (colon > 0 && Object.hasOwn(document.prefixes ?? {}, prefix)) {
      if (
        !iri.slice(colon + 1) ||
        !absoluteIri(document.prefixes![prefix]! + iri.slice(colon + 1))
      ) {
        report('invalid_iri', path, 'The prefixed identifier must expand to a valid absolute IRI.');
      }
    } else if (
      /^[a-z][a-z0-9+.-]*:\//iu.test(iri) ||
      /^(urn|mailto|tel|did|tag|data|file|http|https|ftp|ws|wss):/iu.test(iri)
    ) {
      if (!absoluteIri(iri)) report('invalid_iri', path, 'Expected a valid absolute IRI.');
    } else report('unknown_prefix', path, `Undeclared IRI prefix ${prefix || iri}`);
  };
  document.ontology.forEach((concept, i) => {
    check(concept.iri, `/ontology/${i}/iri`);
    concept.relationships?.forEach((r, j) => check(r.iri, `/ontology/${i}/relationships/${j}/iri`));
  });
}
