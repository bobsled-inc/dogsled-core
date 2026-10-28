import { applyStaticApiRequestAuth } from '@bobsled-inc/api-resource';
import type { ApplyAuthParams, ApplyAuthResult, AuthHandler } from '../http-client.js';

export const apiKeyAuthHandler: AuthHandler = {
  async applyAuth(params: ApplyAuthParams): Promise<ApplyAuthResult> {
    if (params.auth.type !== 'api-key') {
      throw new Error(`Expected api-key auth, got ${params.auth.type}`);
    }
    return applyStaticApiRequestAuth({
      url: params.url,
      method: params.method,
      headers: params.headers,
      body: params.body,
      auth: params.auth,
    });
  },
};
