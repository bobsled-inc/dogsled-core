import { z } from 'zod';
import { CommandError } from '@bobsled-inc/protocol';

const fits = ['supported', 'contradicted', 'mixed', 'unknown'];
const Passages = z
  .array(
    z
      .object({
        id: z.string().regex(/^p[1-9][0-9]{0,2}$/),
        text: z.string().min(1).max(1200),
      })
      .strict()
  )
  .min(1)
  .max(12);
const Ids = z.array(z.string()).max(6);
const decode = (value: unknown): unknown => (typeof value === 'string' ? JSON.parse(value) : value);

export function checkAssessment(row: Record<string, unknown>): void {
  const fail = () => {
    throw new CommandError(
      'Assessment evidence is invalid. Check this show’s passage IDs, source revision and saved text. This is an evidence-link check, not a judgment of recommendation quality. Do not rerun the whole batch.',
      2
    );
  };
  if (!row['_bobsled_run_id'] || !row['revision_id']) fail();
  if (row['passage_ids'] !== undefined) {
    try {
      const passages = Passages.parse(decode(row['input_passages']));
      const ids = Ids.parse(decode(row['passage_ids']));
      const text = row['article_text'];
      if (
        typeof text !== 'string' ||
        text.length > 6000 ||
        !fits.includes(String(row['fit'])) ||
        typeof row['explanation'] !== 'string' ||
        !row['explanation'].trim() ||
        new Set(ids).size !== ids.length ||
        new Set(passages.map((p) => p.id)).size !== passages.length ||
        passages.reduce((n, p) => n + p.text.length, 0) > 6000 ||
        passages.some((p) => !p.text.trim() || !text.includes(p.text))
      ) {
        fail();
      }
      const byId = new Map(passages.map((p) => [p.id, p.text]));
      if (
        ids.some((id) => !byId.has(id)) ||
        (row['fit'] === 'unknown' ? ids.length !== 0 : ids.length === 0) ||
        row['support_excerpt'] !== ids.map((id) => byId.get(id)).join('\n\n')
      ) {
        fail();
      }
    } catch {
      fail();
    }
    return;
  }
  // Keep existing tutorial projects readable; new models use passage IDs.
  const excerpt = row['support_excerpt'];
  const text = row['article_text'];
  if (
    !['identity', 'mystery', 'workplace', 'family', 'other', 'unknown'].includes(
      String(row['theme'])
    ) ||
    typeof excerpt !== 'string' ||
    typeof text !== 'string' ||
    !text.includes(excerpt) ||
    ((row['theme'] !== 'unknown' ||
      row['ending'] !== 'unknown' ||
      (row['fit'] !== undefined && row['fit'] !== 'unknown')) &&
      !excerpt.trim()) ||
    (row['fit'] !== undefined && !fits.includes(String(row['fit']))) ||
    !['concluded', 'unresolved', 'unknown'].includes(String(row['ending']))
  ) {
    fail();
  }
}
