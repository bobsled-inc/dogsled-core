import { describe, expect, it, vi } from 'vitest';

import {
  createLlmPiiDetector,
  createLocalPiiDetector,
  regexPrepass,
} from '../../../src/runtime/pii/detector.js';

describe('regexPrepass', () => {
  it('classifies common high-confidence PII patterns before LLM review', () => {
    const verdicts = regexPrepass({
      fields: [
        { sourceRef: 'crm.contacts', field: 'email', samples: ['Ada@example.com'] },
        { sourceRef: 'crm.contacts', field: 'phone', samples: ['+1 (555) 123-4567'] },
        { sourceRef: 'crm.contacts', field: 'ssn', samples: ['123-45-6789'] },
        { sourceRef: 'crm.contacts', field: 'card', samples: ['4111 1111 1111 1111'] },
        { sourceRef: 'crm.contacts', field: 'company', samples: ['Acme'] },
      ],
    });

    expect(verdicts.find((verdict) => verdict.field === 'email')).toMatchObject({
      pii: true,
      classification: 'email',
      suggested_masking: 'hash',
    });
    expect(verdicts.find((verdict) => verdict.field === 'phone')).toMatchObject({
      pii: true,
      classification: 'phone',
      suggested_masking: 'partial',
    });
    expect(verdicts.find((verdict) => verdict.field === 'ssn')).toMatchObject({
      pii: true,
      classification: 'ssn',
      suggested_masking: 'null',
    });
    expect(verdicts.find((verdict) => verdict.field === 'card')).toMatchObject({
      pii: true,
      classification: 'payment_card',
      suggested_masking: 'null',
    });
    expect(verdicts.find((verdict) => verdict.field === 'company')?.pii).toBe(false);
  });

  it('uses the pii_detection model role for ambiguous fields', async () => {
    const detector = createLlmPiiDetector({
      projectConfig: {
        platform: {
          models: {
            pii_detection: {
              provider: 'openai',
              model: 'gpt-4.1-mini',
              api_key: 'test-key',
            },
          },
        },
      },
      generateStructuredCall: async () => ({
        ok: true,
        value: {
          verdicts: [
            {
              source_ref: 'crm.contacts',
              field: 'notes',
              pii: true,
              classification: 'person_name',
              confidence: 0.82,
              reasons: ['contains names in free text'],
              suggested_masking: 'partial',
            },
          ],
        },
        tokenUsage: 10,
        costUsd: 0.0001,
      }),
    });

    const verdicts = await detector.detect({
      fields: [{ sourceRef: 'crm.contacts', field: 'notes', samples: ['Met Ada at event'] }],
    });

    expect(verdicts).toEqual([
      expect.objectContaining({
        source_ref: 'crm.contacts',
        field: 'notes',
        detector: 'llm',
        pii: true,
        classification: 'person_name',
      }),
    ]);
  });

  it('rejects invalid local detector responses', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify([{ source_ref: 'crm.contacts', field: 'email' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      await expect(
        createLocalPiiDetector('http://localhost:8734/detect').detect({
          fields: [{ sourceRef: 'crm.contacts', field: 'email', samples: ['ada@example.com'] }],
        })
      ).rejects.toThrow(/invalid response shape/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects non-loopback local detector endpoints before fetching', () => {
    const fetchMock = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      expect(() => createLocalPiiDetector('https://attacker.example/detect')).toThrow(
        /must use http\(s\) on localhost/
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('denies redirects and bounds local detector response bodies', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => new Response('x'.repeat(1024 * 1024 + 1), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      await expect(
        createLocalPiiDetector('http://127.0.0.1:8734/detect').detect({
          fields: [{ sourceRef: 'crm.contacts', field: 'email', samples: ['ada@example.com'] }],
        })
      ).rejects.toThrow(/exceeds the 1 MiB limit/);
      expect(fetchMock).toHaveBeenCalledWith(
        new URL('http://127.0.0.1:8734/detect'),
        expect.objectContaining({ redirect: 'error' })
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
