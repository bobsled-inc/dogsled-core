import { describe, it, expect } from 'vitest';

import {
  STATE_BACKEND_CONTRACT_VERSION,
  STATE_BACKEND_PATH,
  isStateBackendErrorResponse,
} from '../../src/state-backend-contract.js';

describe('state backend contract', () => {
  it('exports the canonical endpoint path', () => {
    expect(STATE_BACKEND_PATH).toBe('/v1/state');
  });

  it('exports a contract version literal', () => {
    expect(STATE_BACKEND_CONTRACT_VERSION).toBe(1);
  });

  describe('isStateBackendErrorResponse', () => {
    it('accepts a well-formed error response', () => {
      expect(isStateBackendErrorResponse({ error: { code: 'forbidden', message: 'nope' } })).toBe(
        true
      );
    });

    it('rejects objects missing the error field', () => {
      expect(isStateBackendErrorResponse({ whatever: true })).toBe(false);
    });

    it('rejects non-object inputs', () => {
      expect(isStateBackendErrorResponse(null)).toBe(false);
      expect(isStateBackendErrorResponse(undefined)).toBe(false);
      expect(isStateBackendErrorResponse('string')).toBe(false);
      expect(isStateBackendErrorResponse(42)).toBe(false);
    });

    it('rejects objects where error.code or error.message is missing', () => {
      expect(isStateBackendErrorResponse({ error: {} })).toBe(false);
      expect(isStateBackendErrorResponse({ error: { code: 'x' } })).toBe(false);
      expect(isStateBackendErrorResponse({ error: { message: 'x' } })).toBe(false);
    });
  });
});
