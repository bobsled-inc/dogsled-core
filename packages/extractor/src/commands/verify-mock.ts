import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Writable } from 'node:stream';

import { withPrivateHostAllowlist } from '../framework/core/index.js';
import {
  applyHttpAuth,
  buildOperationRequest,
  clearRuntimeAuthCaches,
  mergeIntegrationOperation,
} from '../framework/runtime/index.js';
import { extractResource, type ExtractOptions } from './extract.js';
import { ExtractorClient, routeHttpRequestParameters } from '../runtime/client.js';
import { ControlLogger } from '../runtime/control.js';
import { Emitter } from '../runtime/emitter.js';
import { FileStateStore } from '../runtime/state.js';

import {
  appendFinding,
  resolveMockFilterOverrides,
  type MockFilterOverrides,
  type VerifyFinding,
} from './verify-shared.js';
import { assertMockRun, type ExpectedRequest } from './verify-mock-assertions.js';
import {
  buildMockEnv,
  isSimpleJsonPath,
  listFixtures,
  normalizeForMock,
  type HttpApiIntegrationSpec,
} from './verify-mock-fixtures.js';
import { createMockServer, type CapturedRequest } from './verify-mock-server.js';
import {
  buildFilterWindows,
  getFilterIncrementalConfig,
  inferCursorKindFromOutput,
} from '../runtime/filter-incremental.js';
import { resolveApiTransport } from '../runtime/transport-client-pool.js';
import type { HttpApiResourceSpec, IntegrationSpec } from '../types/index.js';

type MockRunMetrics = {
  resourcesChecked: number;
  fixturesChecked: number;
  findings: VerifyFinding[];
};

class MemoryWritable extends Writable {
  readonly chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.chunks.push(String(chunk));
    callback();
  }
}

function cloneCapturedRequest(request: CapturedRequest): CapturedRequest {
  return {
    ...request,
    body:
      request.body === undefined
        ? undefined
        : (JSON.parse(JSON.stringify(request.body)) as unknown),
    headers: { ...request.headers },
    query: new URLSearchParams(request.query.toString()),
  };
}

async function buildExpectedFirstRequest(
  integration: HttpApiIntegrationSpec,
  resource: HttpApiResourceSpec,
  fixtureInput: Record<string, unknown>,
  env: Record<string, string>,
  stateDir: string,
  now: Date,
  filterOverrides: MockFilterOverrides
): Promise<ExpectedRequest> {
  const mergedApi = mergeIntegrationOperation(integration, resource.api);
  let routedApi = mergedApi;
  let routedInput = fixtureInput;
  let routedQueryParams: Record<string, string | number | boolean> = {};
  const filterConfig = getFilterIncrementalConfig(resource);
  const cursorKind =
    resource.extract.incremental?.cursor_type ??
    inferCursorKindFromOutput(resource, resource.extract.incremental?.cursor_field);

  if (filterConfig && cursorKind && cursorKind !== 'lsn') {
    const windows = buildFilterWindows({
      config: filterConfig,
      cursorKind,
      sinceOverride: filterOverrides.sinceOverride,
      untilOverride: filterOverrides.untilOverride,
      now,
    });
    const firstWindow = windows[0];
    if (firstWindow) {
      const routed = routeHttpRequestParameters(
        mergedApi,
        resource.input,
        fixtureInput,
        firstWindow.params
      );
      routedApi = routed.api;
      routedInput = routed.input;
      routedQueryParams = routed.queryParams;
    }
  }

  const baseRequest = await buildOperationRequest({
    api: routedApi,
    inputSchema: resource.input,
    providedInput: routedInput,
    context: {
      declaredEnvVars: new Set(integration.auth_env_vars),
      env,
      integration: {
        base_url: integration.transport.base_url,
      },
      secrets: env,
    },
  });
  const url = new URL(baseRequest.url);
  for (const [key, value] of Object.entries(routedQueryParams)) {
    url.searchParams.set(key, String(value));
  }
  const request = { ...baseRequest, url: url.toString() };

  return applyHttpAuth({
    ...request,
    auth: request.auth,
    integrationName: integration.name,
    interpolationContext: {
      declaredEnvVars: new Set(integration.auth_env_vars),
      env,
      integration: {
        base_url: integration.transport.base_url,
      },
      secrets: env,
    },
    stateDir,
  });
}

export async function runMockVerification(
  integrationName: string,
  integration: IntegrationSpec,
  resources: HttpApiResourceSpec[]
): Promise<MockRunMetrics> {
  const findings: VerifyFinding[] = [];
  let fixturesChecked = 0;
  let resourcesChecked = 0;

  for (const resource of resources) {
    let resolvedIntegration: HttpApiIntegrationSpec;
    try {
      const resolved = resolveApiTransport(integration, resource);
      if (resolved.integration.transport.type !== 'http') {
        appendFinding(
          findings,
          integrationName,
          'info',
          'MOCK_SKIPPED_TRANSPORT',
          'Mock verification only supports HTTP integrations',
          resource.name
        );
        continue;
      }
      resolvedIntegration = resolved.integration as HttpApiIntegrationSpec;
    } catch (error) {
      appendFinding(
        findings,
        integrationName,
        'error',
        'MOCK_TRANSPORT_RESOLUTION_FAILED',
        `Unable to resolve an HTTP transport: ${error instanceof Error ? error.message : String(error)}`,
        resource.name
      );
      continue;
    }

    if (!isSimpleJsonPath(resource.extract.record_path ?? '$')) {
      appendFinding(
        findings,
        integrationName,
        'warn',
        'MOCK_SKIPPED_RECORD_PATH',
        'Mock verification only supports simple record_path values',
        resource.name
      );
      continue;
    }

    const fixtures = listFixtures(resource);
    resourcesChecked += 1;
    for (const fixture of fixtures) {
      fixturesChecked += 1;
      const requests: CapturedRequest[] = [];
      const baseUrlRef = { current: 'http://127.0.0.1' };
      const server = await createMockServer(resource, fixture.input, baseUrlRef, requests);
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extractor-verify-mock-'));
      const protocolStream = new MemoryWritable();
      const controlStream = new MemoryWritable();
      try {
        await withPrivateHostAllowlist(['127.0.0.1'], async () => {
          const { authMode, mockIntegration, mockResource } = normalizeForMock(
            resolvedIntegration,
            resource,
            baseUrlRef.current
          );
          const env = buildMockEnv(mockIntegration, mockResource);
          const stateStore = new FileStateStore(path.join(tmpDir, 'state'));
          const state = await stateStore.load();
          const mockNow = new Date();
          const filterOverrides = resolveMockFilterOverrides(mockResource, fixture.input, mockNow);
          const expectedFirstRequest = await buildExpectedFirstRequest(
            mockIntegration,
            mockResource,
            fixture.input,
            env,
            path.join(tmpDir, 'expected-state'),
            mockNow,
            filterOverrides
          );
          const expectedAuthRequests = requests
            .filter((request) => request.kind === 'auth')
            .map((request) => cloneCapturedRequest(request));
          requests.length = 0;
          clearRuntimeAuthCaches();

          const emitter = new Emitter('stdout', path.join(tmpDir, 'output'), {
            stdoutStream: protocolStream,
          });
          const logger = new ControlLogger({
            logFormat: 'json',
            quiet: true,
            stream: controlStream,
          });

          const client = new ExtractorClient({
            env,
            integration: mockIntegration,
            secrets: env,
            stateDir: path.join(tmpDir, 'state'),
          });

          const opts: ExtractOptions = {
            advanceState: true,
            ...(filterOverrides.sinceOverride !== undefined
              ? { sinceOverride: filterOverrides.sinceOverride }
              : {}),
            ...(filterOverrides.untilOverride !== undefined
              ? { untilValue: filterOverrides.untilOverride }
              : {}),
          };

          await extractResource({
            integration: mockIntegration,
            integrationName,
            resource: mockResource,
            client,
            emitter,
            logger,
            state,
            stateStore,
            batchDir: path.join(tmpDir, 'batch'),
            opts,
            inputOverrides: fixture.input,
          });

          await emitter.close();
          await logger.close();

          assertMockRun(
            integrationName,
            mockIntegration,
            mockResource,
            fixture.name,
            authMode,
            requests,
            expectedAuthRequests,
            protocolStream.chunks,
            expectedFirstRequest,
            findings
          );
        });
      } catch (error) {
        appendFinding(
          findings,
          integrationName,
          'error',
          'MOCK_EXECUTION_FAILED',
          `Fixture "${fixture.name}" failed: ${error instanceof Error ? error.message : String(error)}`,
          resource.name
        );
      } finally {
        clearRuntimeAuthCaches();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeIdleConnections?.();
          server.closeAllConnections?.();
        });
        fs.rmSync(tmpDir, { force: true, recursive: true });
      }
    }
  }

  return {
    findings,
    fixturesChecked,
    resourcesChecked,
  };
}
