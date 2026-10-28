// Sample external reviewer (command transport) for the entity-graph demo.
//
// `entity-graph resolve review` pipes an entity_graph_review_request.v1
// document to stdin; this script answers every pair from the composite score
// alone and prints {decisions} to stdout. Wire it up by uncommenting the
// `reviewer:` block in entity-graph/company_resolution.yml. Full contract:
// docs/reference/advanced/entity-graph-reviewer-contract.md.
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const request = JSON.parse(raw);

const decisions = request.pairs.map((pair) => {
  const score = pair.compositeScore ?? 0;
  const decision = score >= 0.85 ? 'merge' : score < 0.65 ? 'not_match' : 'defer';
  return {
    pairId: pair.pairId,
    decision,
    confidence: decision === 'defer' ? 0.3 : score,
    reasoning: `sample reviewer: composite score ${score.toFixed(3)}`,
  };
});

process.stdout.write(JSON.stringify({ decisions }));
