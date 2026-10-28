// Command-transport reviewer fixture: reads an entity_graph_review_request.v1
// payload on stdin and answers every pair with the decision/confidence given
// on argv, e.g. `node echo-decisions.mjs merge 0.95`.
import { argv, stdin, stdout } from 'node:process';

let raw = '';
for await (const chunk of stdin) raw += chunk;
const request = JSON.parse(raw);
if (request.version !== 'entity_graph_review_request.v1') {
  throw new Error(`unexpected request version: ${String(request.version)}`);
}

const decision = argv[2] ?? 'merge';
const confidence = Number(argv[3] ?? '0.95');
stdout.write(
  JSON.stringify({
    decisions: request.pairs.map((pair) => ({
      pairId: pair.pairId,
      decision,
      confidence,
      reasoning: `fixture ${decision} for ${request.job.entity}`,
    })),
  })
);
