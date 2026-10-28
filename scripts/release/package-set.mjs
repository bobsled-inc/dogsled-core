export const DOGSLED_PACKAGE_NAME = '@bobsled-inc/dogsled';

export const INTERNAL_PACKAGE_NAMES = [
  '@bobsled-inc/ai',
  '@bobsled-inc/api-resource',
  '@bobsled-inc/connections',
  '@bobsled-inc/document-parsers',
  '@bobsled-inc/embedder',
  '@bobsled-inc/entity-graph',
  '@bobsled-inc/extractor',
  '@bobsled-inc/integrations',
  '@bobsled-inc/loader',
  '@bobsled-inc/model-spec',
  '@bobsled-inc/models',
  '@bobsled-inc/project-index',
  '@bobsled-inc/protocol',
  '@bobsled-inc/sdk-codegen',
  '@bobsled-inc/skills',
];

export const EXPECTED_INTERNAL_PACKAGE_COUNT = INTERNAL_PACKAGE_NAMES.length;

export const BUNDLED_EXTERNAL_PACKAGE_NAMES = ['zod'];

// These providers are implementation details of @bobsled-inc/ai. They are
// bundled into its output so their peer requirements (notably the incompatible
// zod range declared by Ollama) cannot leak into Dogsled consumers.
export const INLINED_AI_DEPENDENCY_NAMES = [
  '@ai-sdk/amazon-bedrock',
  '@ai-sdk/anthropic',
  '@ai-sdk/google',
  '@ai-sdk/openai',
  '@openrouter/ai-sdk-provider',
  'ai',
  'ollama-ai-provider',
];

// Source-checkout assets that bundled internal packages read at run time. The
// staging step copies each one into the named package under `target`.
export const BUNDLED_PACKAGE_ASSETS = [
  {
    package: '@bobsled-inc/entity-graph',
    source: 'packages/entity-graph/tests/fixtures/specs/resolutions',
    target: 'fixtures/b2b-company-master',
  },
];
