import { describe, expect, it } from 'vitest';
import {
  applyHostEnvironmentDeclarations,
  getEmbedConfig,
} from '../../../src/commands/pipeline-run-helpers.js';

const embed = {
  provider: 'openai',
  model: 'text-embedding-3-small',
  api_key: '$HOST_EMBED_KEY',
  auth_env_vars: ['AUTHORED_KEY'],
  streams: { issues: [{ field: 'title' }] },
};

describe('pipeline embedding host declarations', () => {
  it('merges supplied names before validation and preserves the placeholder', () => {
    const options = { integration: 'example', embedConfigJson: JSON.stringify(embed) };
    expect(() =>
      getEmbedConfig(applyHostEnvironmentDeclarations(options, { HOST_EMBED_KEY: 'canary' }))
    ).toThrow('Undeclared API key environment variable: HOST_EMBED_KEY');
    const declared = { ...options, declaredEnvNames: ['HOST_EMBED_KEY'] };
    expect(() => applyHostEnvironmentDeclarations(declared, {})).toThrow(
      'must be supplied in options.env'
    );
    expect(
      getEmbedConfig(applyHostEnvironmentDeclarations(declared, { HOST_EMBED_KEY: 'canary' }))
    ).toMatchObject({
      api_key: '$HOST_EMBED_KEY',
      auth_env_vars: ['AUTHORED_KEY', 'HOST_EMBED_KEY'],
    });
    expect(JSON.parse(options.embedConfigJson)).toEqual(embed);
  });
});
