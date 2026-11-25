import { CommandError, EXIT_ERROR } from '@bobsled-inc/protocol';

export interface EmbedBatchResult {
  /** In input order. `null` only where the provider reported a refusal. */
  vectors: Array<number[] | null>;
  tokensUsed: number;
  /** Provider requests this took. Defaults to 1. */
  apiCalls?: number;
  /** Refused inputs, counted by the provider's error code. */
  rejections?: ReadonlyMap<string, number>;
}

export interface EmbedTarget {
  stream: string;
  model: string;
  dimensions: number;
}

/** Refuse a result that does not fit the declared vector column. Messages hold no text. */
export function assertEmbedResult(
  result: EmbedBatchResult,
  expectedCount: number,
  target: EmbedTarget
): void {
  const where = `for stream "${target.stream}"`;
  const refuse = (problem: string): never => {
    throw new CommandError(`Embedding model "${target.model}" ${problem}`, EXIT_ERROR);
  };
  if (result.vectors.length !== expectedCount) {
    throw new Error(
      `Expected ${expectedCount} embeddings ${where}, received ${result.vectors.length}`
    );
  }

  let missing = 0;
  // `for...of` also visits a vector that was never set.
  for (const vector of result.vectors) {
    if (vector === null) {
      missing += 1;
      continue;
    }
    const length = Array.isArray(vector) ? vector.length : 0;
    if (length !== target.dimensions) {
      refuse(`returned a vector of ${length} numbers ${where}, expected ${target.dimensions}.`);
    }
    if (!vector.every((number) => Number.isFinite(number))) {
      refuse(`returned a vector with a value that is not a finite number ${where}.`);
    }
  }

  let refused = 0;
  for (const count of result.rejections?.values() ?? []) refused += count;
  if (missing !== refused) {
    refuse(`left out ${missing} vectors ${where}, but reported ${refused} refused inputs.`);
  }
}
