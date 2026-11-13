import type { AgenticPublicationContext, AgenticPublisher } from '../../src/agentic/publication.js';
import { digestAgenticState } from '../../src/agentic/state.js';
import { agenticRowsDigest, agenticSchemaDigest } from '../../src/agentic/publication.js';
import { AGENTIC_ROW_STORE_LIMITS } from '../../src/agentic/store-limits.js';

export function publicationPayload(
  context: AgenticPublicationContext,
  rowCount: number,
  bytes?: number
) {
  const keys = Array.from({ length: rowCount }, (_, index) => ({ pair_id: 'p' + index }));
  const rows = keys.map((key) => ({
    ...key,
    assessment: '',
    _dogsled_run_id: 'boundary',
    _dogsled_evidence: null,
    _dogsled_confidence: null,
    _dogsled_reason: null,
  }));
  if (bytes !== undefined) {
    // Make some rows wide and use UTF-8 text so a row count or character count alone is insufficient.
    const wideRows = rows.slice(0, 32);
    const padding = bytes - Buffer.byteLength(JSON.stringify(rows));
    const width = Math.floor(padding / wideRows.length);
    for (const [index, row] of wideRows.entries()) {
      const size = width + Number(index < padding % wideRows.length);
      row.assessment = 'é'.repeat(Math.floor(size / 2)) + 'a'.repeat(size % 2);
    }
  }
  const fields = {
    run: { scope: 'test', model: context.resolved.model.name, id: 'boundary' },
    definition_digest: digestAgenticState(context),
    target: context.target,
    schema_digest: agenticSchemaDigest(context.resolved.output_columns),
    results_digest: agenticRowsDigest(rows),
    processed_keys_digest: digestAgenticState(keys),
  };
  return { rows, keys, identity: { ...fields, operation_id: digestAgenticState(fields) } };
}

export function fullPublicationPayload(context: AgenticPublicationContext) {
  return publicationPayload(
    context,
    AGENTIC_ROW_STORE_LIMITS.maxRows,
    AGENTIC_ROW_STORE_LIMITS.maxBatchBytes
  );
}

export async function publishPayload(
  publisher: AgenticPublisher,
  context: AgenticPublicationContext,
  { identity, rows, keys }: ReturnType<typeof publicationPayload>,
  limits?: Parameters<AgenticPublisher['prepare']>[6]
) {
  const claim = await publisher.claim(context.target);
  const intent = await publisher.prepare(context, identity, rows, keys, claim, undefined, limits);
  return publisher.commit(intent, claim);
}
