import { fromNodeProviderChain } from '@aws-sdk/credential-providers';

import { EnvSecretResolver } from '@bobsled-inc/connections';
import {
  CommandError,
  EXIT_VALIDATION,
  parseEnvPlaceholder,
  validateModelProviderConfig,
} from '@bobsled-inc/protocol';

import { assertExhaustive } from './assert-exhaustive.js';
import { currentModelVersionFor } from './model-families.js';
import { createBoundedOpenRouterFetch } from './openrouter-fetch.js';
import type { ModelConnection } from './types.js';

type ProviderCallable = (modelId: string) => unknown;
type ProviderObject = ProviderCallable & {
  embedding?: ProviderCallable;
  textEmbeddingModel?: ProviderCallable;
};

export interface ProviderModels {
  embeddingModel?: unknown;
  languageModel?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function getFactory(
  moduleValue: unknown,
  name: string
): (options: Record<string, unknown>) => unknown {
  const factory = asRecord(moduleValue)[name];
  if (typeof factory !== 'function') {
    throw new CommandError(`AI provider package does not export ${name}()`, EXIT_VALIDATION);
  }
  return factory as (options: Record<string, unknown>) => unknown;
}

function providerModels(provider: unknown, modelId: string): ProviderModels {
  const callable = provider as ProviderObject;
  // Some providers expose factories that throw for unsupported model kinds.
  // Resolve only the kind the caller uses, and reuse that model on later reads.
  let embeddingModel: unknown;
  let languageModel: unknown;
  let embeddingResolved = false;
  let languageResolved = false;
  return {
    get embeddingModel() {
      if (!embeddingResolved) {
        embeddingModel =
          typeof callable.embedding === 'function'
            ? callable.embedding(modelId)
            : typeof callable.textEmbeddingModel === 'function'
              ? callable.textEmbeddingModel(modelId)
              : undefined;
        embeddingResolved = true;
      }
      return embeddingModel;
    },
    get languageModel() {
      if (!languageResolved) {
        languageModel = typeof callable === 'function' ? callable(modelId) : undefined;
        languageResolved = true;
      }
      return languageModel;
    },
  };
}

function isOpenAiEmbeddingModel(modelId: string): boolean {
  return modelId.startsWith('text-embedding-');
}

function openAiProviderModels(provider: unknown, modelId: string): ProviderModels {
  const callable = provider as ProviderObject;
  if (isOpenAiEmbeddingModel(modelId)) {
    const embeddingFactory =
      typeof callable.embedding === 'function'
        ? callable.embedding
        : typeof callable.textEmbeddingModel === 'function'
          ? callable.textEmbeddingModel
          : undefined;
    return { embeddingModel: embeddingFactory?.(modelId) };
  }

  return { languageModel: typeof callable === 'function' ? callable(modelId) : undefined };
}

async function resolveApiKey(
  apiKey: string,
  env: Record<string, string | undefined>
): Promise<string> {
  const envVarName = parseEnvPlaceholder(apiKey);
  if (envVarName === null) {
    return apiKey;
  }
  return new EnvSecretResolver(env).resolve(envVarName);
}

export async function resolveProviderModels(
  connection: ModelConnection,
  env: Record<string, string | undefined> = process.env
): Promise<ProviderModels> {
  validateModelProviderConfig(connection);
  switch (connection.provider) {
    case 'amazon-bedrock': {
      const moduleValue = await import('@ai-sdk/amazon-bedrock');
      const createAmazonBedrock = getFactory(
        moduleValue,
        'createAmazonBedrock'
      ) as typeof import('@ai-sdk/amazon-bedrock').createAmazonBedrock;
      type AmazonBedrockOptions = NonNullable<Parameters<typeof createAmazonBedrock>[0]>;
      const options: AmazonBedrockOptions = { region: connection.region };
      if (connection.api_key) {
        options.apiKey = await resolveApiKey(connection.api_key, env);
      } else {
        options.credentialProvider = fromNodeProviderChain();
      }
      const provider = createAmazonBedrock(options);
      return providerModels(provider, connection.model);
    }
    case 'typesafe':
      throw new CommandError('TypeSafe supports agentic classification only', EXIT_VALIDATION);
    case 'ai-gateway': {
      const moduleValue = await import('ai');
      const createGateway = getFactory(moduleValue, 'createGateway');
      const provider = createGateway({ apiKey: await resolveApiKey(connection.api_key, env) });
      return providerModels(provider, currentModelVersionFor(connection.model));
    }
    case 'openai': {
      const moduleValue = await import('@ai-sdk/openai');
      const createOpenAI = getFactory(moduleValue, 'createOpenAI');
      const provider = createOpenAI({ apiKey: await resolveApiKey(connection.api_key, env) });
      return openAiProviderModels(provider, connection.model);
    }
    case 'anthropic': {
      const moduleValue = await import('@ai-sdk/anthropic');
      const createAnthropic = getFactory(moduleValue, 'createAnthropic');
      const provider = createAnthropic({ apiKey: await resolveApiKey(connection.api_key, env) });
      return providerModels(provider, connection.model);
    }
    case 'google': {
      const moduleValue = await import('@ai-sdk/google');
      const createGoogleGenerativeAI = getFactory(moduleValue, 'createGoogleGenerativeAI');
      const provider = createGoogleGenerativeAI({
        apiKey: await resolveApiKey(connection.api_key, env),
      });
      return providerModels(provider, connection.model);
    }
    case 'ollama': {
      const moduleValue = await import('ollama-ai-provider');
      const createOllama = getFactory(moduleValue, 'createOllama');
      const provider = createOllama({ baseURL: connection.base_url });
      return providerModels(provider, connection.model);
    }
    case 'openrouter': {
      const moduleValue = await import('@openrouter/ai-sdk-provider');
      const createOpenRouter = getFactory(moduleValue, 'createOpenRouter');
      const provider = createOpenRouter({
        apiKey: await resolveApiKey(connection.api_key, env),
        fetch: createBoundedOpenRouterFetch(),
      });
      return providerModels(provider, connection.model);
    }
    default:
      assertExhaustive(connection);
  }
}
