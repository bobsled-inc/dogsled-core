/**
 * Deterministic-seed scale corpus generator.
 *
 * Produces a synthetic mention-extraction corpus large enough to surface
 * O(n²) clustering and FTS-vs-vector mismatches before they hit
 * production. Hardcoded seed + manifest hash means CI can cache the
 * generated corpus and only regenerate when the generator itself
 * changes — the smoke variant runs every PR; the full 10K/10M variant
 * runs nightly behind `RUN_SCALE_TESTS=1`.
 *
 * Output shape:
 *   {
 *     entities: Array<{ entity_id: string; canonical_name: string }>,
 *     documents: Array<{ document_id: string; title: string; body: string; mentions: string[] }>,
 *     chunks: Array<{ chunk_id: string; document_id: string; chunk_index: number; chunk_text: string }>,
 *     manifest: { entity_count, document_count, chunk_count, hash }
 *   }
 *
 * The generator is intentionally pure (no FS / no warehouse); callers
 * pick the persistence layer.
 */

import { createHash } from 'node:crypto';

export interface ScaleCorpusEntity {
  entity_id: string;
  canonical_name: string;
}

export interface ScaleCorpusDocument {
  document_id: string;
  title: string;
  body: string;
  /** Subset of entity_ids that the body mentions by surface form. */
  mentions: string[];
}

export interface ScaleCorpusChunk {
  chunk_id: string;
  document_id: string;
  chunk_index: number;
  chunk_text: string;
}

export interface ScaleCorpusManifest {
  entity_count: number;
  document_count: number;
  chunk_count: number;
  /** sha256 over a stable shape — `corpus_id` for cache lookup. */
  hash: string;
  seed: number;
}

export interface ScaleCorpus {
  entities: ScaleCorpusEntity[];
  documents: ScaleCorpusDocument[];
  chunks: ScaleCorpusChunk[];
  manifest: ScaleCorpusManifest;
}

export interface ScaleCorpusOptions {
  entity_count: number;
  document_count: number;
  /** Average chunks per document. The exact count varies with body length. */
  avg_chunks_per_doc: number;
  /** Mulberry32 seed — identical seed produces identical corpus. */
  seed: number;
}

/**
 * Mulberry32 — fast, seedable PRNG with good distribution for
 * synthetic-data generation. Replaces Math.random() so the corpus is
 * fully deterministic (CI cache hit on identical inputs).
 */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const COMPANY_PREFIXES = [
  'Acme',
  'Globex',
  'Initech',
  'Hooli',
  'Pied Piper',
  'Aperture',
  'Anvil',
  'Vandelay',
  'Sterling',
  'Massive Dynamic',
];
const COMPANY_SUFFIXES = ['Corp', 'Inc', 'LLC', 'Industries', 'Systems', 'Holdings', 'Group'];

function pickCompanyName(rng: () => number, idx: number): string {
  const prefix = COMPANY_PREFIXES[Math.floor(rng() * COMPANY_PREFIXES.length)] ?? 'Acme';
  const suffix = COMPANY_SUFFIXES[Math.floor(rng() * COMPANY_SUFFIXES.length)] ?? 'Corp';
  // Guarantee uniqueness per index — bare prefix+suffix collides at scale.
  return `${prefix} ${suffix} ${idx}`;
}

function chunkBody(body: string, targetChunkChars = 320): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < body.length) {
    const end = Math.min(i + targetChunkChars, body.length);
    out.push(body.slice(i, end));
    i = end;
  }
  return out;
}

export function generateScaleCorpus(options: ScaleCorpusOptions): ScaleCorpus {
  if (!Number.isInteger(options.entity_count) || options.entity_count < 0) {
    throw new Error(
      `generateScaleCorpus: entity_count must be a non-negative integer ` +
        `(got ${String(options.entity_count)})`
    );
  }
  if (!Number.isInteger(options.document_count) || options.document_count < 0) {
    throw new Error(
      `generateScaleCorpus: document_count must be a non-negative integer ` +
        `(got ${String(options.document_count)})`
    );
  }
  // Fail fast on a non-finite or negative avg_chunks_per_doc — it
  // determines paddingTarget; an Infinity / NaN value would make the
  // padding loop non-terminating.
  if (!Number.isFinite(options.avg_chunks_per_doc) || options.avg_chunks_per_doc < 0) {
    throw new Error(
      `generateScaleCorpus: avg_chunks_per_doc must be a finite non-negative number ` +
        `(got ${String(options.avg_chunks_per_doc)})`
    );
  }
  const rng = mulberry32(options.seed);
  const entities: ScaleCorpusEntity[] = [];
  for (let i = 0; i < options.entity_count; i++) {
    entities.push({
      entity_id: `e_${i.toString().padStart(6, '0')}`,
      canonical_name: pickCompanyName(rng, i),
    });
  }
  const documents: ScaleCorpusDocument[] = [];
  const chunks: ScaleCorpusChunk[] = [];
  for (let d = 0; d < options.document_count; d++) {
    const documentId = `doc_${d.toString().padStart(7, '0')}`;
    const mentionCount = 1 + Math.floor(rng() * 3);
    const mentions: string[] = [];
    const sentences: string[] = [];
    for (let m = 0; m < mentionCount; m++) {
      const e = entities[Math.floor(rng() * entities.length)];
      if (!e) continue;
      mentions.push(e.entity_id);
      sentences.push(`${e.canonical_name} delivered Q${1 + Math.floor(rng() * 4)} update.`);
    }
    // Pad with filler sentences so chunk counts roughly match avg.
    // Track current length incrementally so we don't pay O(n²)
    // string-rebuild cost per iteration.
    const paddingTarget = options.avg_chunks_per_doc * 320;
    let currentLen = sentences.join(' ').length;
    while (currentLen < paddingTarget) {
      const filler = `Filler sentence ${sentences.length} contains structural padding to drive chunk count toward target.`;
      // Account for the join separator (' ') only when there's already
      // something to separate from.
      currentLen += (currentLen > 0 ? 1 : 0) + filler.length;
      sentences.push(filler);
    }
    const body = sentences.join(' ');
    const title = `Synthetic doc ${d}`;
    documents.push({ document_id: documentId, title, body, mentions });
    const splits = chunkBody(body);
    for (let c = 0; c < splits.length; c++) {
      const chunkText = splits[c] ?? '';
      const chunkId = createHash('sha256')
        .update(`${documentId}::${c}::${chunkText}`)
        .digest('hex')
        .slice(0, 32);
      chunks.push({
        chunk_id: chunkId,
        document_id: documentId,
        chunk_index: c,
        chunk_text: chunkText,
      });
    }
  }
  // Manifest hash inputs:
  //   - generator_version: bump whenever the generator algorithm changes
  //     in a way that should invalidate cached corpora (template tweaks,
  //     mention-count distribution shifts, padding changes, etc.).
  //   - corpus shape: entity/doc/chunk counts + seed.
  //   - sample of chunk_ids: ties the hash to actual content so a code
  //     change that yields the same shape but different content
  //     produces a different cache key.
  const generatorVersion = 'scale-corpus@2';
  const sampleChunkIds = chunks.slice(0, Math.min(chunks.length, 16)).map((c) => c.chunk_id);
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        generator_version: generatorVersion,
        avg_chunks_per_doc: options.avg_chunks_per_doc,
        entities: entities.length,
        documents: documents.length,
        chunks: chunks.length,
        seed: options.seed,
        sample_chunk_ids: sampleChunkIds,
      })
    )
    .digest('hex')
    .slice(0, 16);
  return {
    entities,
    documents,
    chunks,
    manifest: {
      entity_count: entities.length,
      document_count: documents.length,
      chunk_count: chunks.length,
      hash,
      seed: options.seed,
    },
  };
}
