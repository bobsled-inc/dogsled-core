import { z } from 'zod';
import { generateStructured, resolveModelConnection } from '@bobsled-inc/ai';
import { CommandError } from '@bobsled-inc/protocol';

import type { PlatformConfig } from '@bobsled-inc/ai';

export interface FieldSamples {
  fields: Array<{
    sourceRef: string;
    field: string;
    samples: string[];
  }>;
}

const BasePiiVerdictSchema = z.object({
  source_ref: z.string(),
  field: z.string(),
  pii: z.boolean(),
  classification: z.string(),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string()),
  suggested_masking: z.enum(['none', 'hash', 'partial', 'null']),
});

const FieldPiiVerdictSchema = BasePiiVerdictSchema.extend({
  detector: z.enum(['regex', 'llm', 'local']),
});

const LocalVerdictsSchema = z.array(FieldPiiVerdictSchema);

export type FieldPiiVerdict = z.infer<typeof FieldPiiVerdictSchema>;

export interface PiiDetector {
  detect(samples: FieldSamples): Promise<FieldPiiVerdict[]>;
}

const LlmVerdictSchema = z.object({
  verdicts: z.array(BasePiiVerdictSchema),
});

type LlmVerdicts = z.infer<typeof LlmVerdictSchema>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const PHONE_RE = /^\+?[0-9().\-\s]{7,}$/u;
const SSN_RE = /^(?!000|666|9\d\d)\d{3}[- ]?(?!00)\d{2}[- ]?(?!0000)\d{4}$/u;
const CARD_CANDIDATE_RE = /^[0-9][0-9 -]{11,24}[0-9]$/u;

function luhnValid(value: string): boolean {
  const digits = value.replace(/[^0-9]/gu, '');
  if (digits.length < 12 || digits.length > 19) return false;
  let sum = 0;
  let doubleDigit = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i]);
    if (doubleDigit) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function classifyValue(value: string): {
  classification: string;
  masking: FieldPiiVerdict['suggested_masking'];
  reason: string;
} | null {
  const trimmed = value.trim();
  if (EMAIL_RE.test(trimmed)) {
    return { classification: 'email', masking: 'hash', reason: 'sample matched email pattern' };
  }
  if (SSN_RE.test(trimmed)) {
    return { classification: 'ssn', masking: 'null', reason: 'sample matched SSN pattern' };
  }
  if (CARD_CANDIDATE_RE.test(trimmed) && luhnValid(trimmed)) {
    return {
      classification: 'payment_card',
      masking: 'null',
      reason: 'sample matched payment card checksum',
    };
  }
  if (PHONE_RE.test(trimmed) && trimmed.replace(/[^0-9]/gu, '').length >= 7) {
    return { classification: 'phone', masking: 'partial', reason: 'sample matched phone pattern' };
  }
  return null;
}

function classifyFieldName(field: string): {
  classification: string;
  masking: FieldPiiVerdict['suggested_masking'];
  reason: string;
} | null {
  const normalized = field.toLowerCase();
  if (normalized.includes('email')) {
    return { classification: 'email', masking: 'hash', reason: 'field name contains email' };
  }
  if (normalized.includes('ssn') || normalized.includes('social_security')) {
    return { classification: 'ssn', masking: 'null', reason: 'field name indicates SSN' };
  }
  if (normalized.includes('phone') || normalized.includes('mobile')) {
    return { classification: 'phone', masking: 'partial', reason: 'field name indicates phone' };
  }
  if (/(^|_)(card|credit_card|payment_card|pan)(_|$)/u.test(normalized)) {
    return {
      classification: 'payment_card',
      masking: 'null',
      reason: 'field name indicates payment card',
    };
  }
  return null;
}

export function regexPrepass(samples: FieldSamples): FieldPiiVerdict[] {
  return samples.fields.map((fieldSamples) => {
    const hits = fieldSamples.samples
      .map((sample) => classifyValue(sample))
      .filter((hit): hit is NonNullable<typeof hit> => hit !== null);
    const nameHit = classifyFieldName(fieldSamples.field);
    const best = hits[0] ?? nameHit;
    if (!best) {
      return {
        source_ref: fieldSamples.sourceRef,
        field: fieldSamples.field,
        pii: false,
        classification: 'none',
        confidence: 0.2,
        detector: 'regex',
        reasons: [],
        suggested_masking: 'none',
      };
    }
    return {
      source_ref: fieldSamples.sourceRef,
      field: fieldSamples.field,
      pii: true,
      classification: best.classification,
      confidence: hits.length > 0 ? 0.98 : 0.75,
      detector: 'regex',
      reasons: Array.from(new Set([best.reason, ...hits.map((hit) => hit.reason)])),
      suggested_masking: best.masking,
    };
  });
}

export function createRegexPiiDetector(): PiiDetector {
  return { detect: async (samples) => regexPrepass(samples) };
}

const MAX_LOCAL_PII_RESPONSE_BYTES = 1024 * 1024;

function validateLocalPiiEndpoint(endpoint: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new CommandError('Local PII detector endpoint must be a valid loopback URL.', 2);
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    !['localhost', '127.0.0.1', '::1'].includes(hostname)
  ) {
    throw new CommandError(
      'Local PII detector endpoint must use http(s) on localhost, 127.0.0.1, or ::1 with no credentials.',
      2
    );
  }
  return parsed;
}

async function readLocalPiiResponse(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isSafeInteger(declaredLength) && declaredLength > MAX_LOCAL_PII_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new CommandError('Local PII detector response exceeds the 1 MiB limit.', 1);
  }
  if (!response.body) {
    throw new CommandError('Local PII detector returned an empty response.', 1);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_LOCAL_PII_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new CommandError('Local PII detector response exceeds the 1 MiB limit.', 1);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new CommandError('Local PII detector returned a non-JSON response.', 1);
  }
}

export function createLocalPiiDetector(endpoint: string): PiiDetector {
  const parsedEndpoint = validateLocalPiiEndpoint(endpoint);
  return {
    async detect(samples) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      let response: Response;
      try {
        response = await fetch(parsedEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(samples),
          redirect: 'error',
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new CommandError('Local PII detector timed out after 10000ms.', 1);
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) {
        throw new CommandError(`Local PII detector failed with HTTP ${response.status}.`, 1);
      }
      const body = await readLocalPiiResponse(response);
      const result = LocalVerdictsSchema.safeParse(body);
      if (!result.success) {
        throw new CommandError('Local PII detector returned an invalid response shape.', 1);
      }
      return result.data;
    },
  };
}

export function createLlmPiiDetector(options: {
  projectConfig: { platform?: PlatformConfig };
  projectKey?: string;
  env?: Record<string, string | undefined>;
  generateStructuredCall?: typeof generateStructured;
}): PiiDetector {
  return {
    async detect(samples) {
      const regexVerdicts = regexPrepass(samples);
      const ambiguous = regexVerdicts.filter((verdict) => !verdict.pii);
      if (ambiguous.length === 0) return regexVerdicts;

      const connection = resolveModelConnection('pii_detection', options.projectConfig);
      const structured = options.generateStructuredCall ?? generateStructured;
      const result = await structured<LlmVerdicts>(
        connection,
        {
          schema: LlmVerdictSchema,
          system:
            'Classify fields for likely PII with high recall. Prefer false positives over false negatives in privacy contexts.',
          prompt: JSON.stringify({
            fields: samples.fields.filter((field) =>
              ambiguous.some(
                (verdict) => verdict.source_ref === field.sourceRef && verdict.field === field.field
              )
            ),
          }),
        },
        {
          env: options.env,
          platform: options.projectConfig.platform,
          projectKey: options.projectKey,
        }
      );
      if (!result.ok) {
        throw new CommandError(`PII detector model call failed: ${result.message}`, 1);
      }
      const llmByKey = new Map(
        result.value.verdicts.map((verdict) => [`${verdict.source_ref}\0${verdict.field}`, verdict])
      );
      return regexVerdicts.map((verdict) => {
        if (verdict.pii) return verdict;
        const llm = llmByKey.get(`${verdict.source_ref}\0${verdict.field}`);
        return llm
          ? {
              ...llm,
              detector: 'llm' as const,
            }
          : verdict;
      });
    },
  };
}
