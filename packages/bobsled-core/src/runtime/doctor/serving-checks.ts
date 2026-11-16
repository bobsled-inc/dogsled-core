/**
 * Entity-graph serving doctor checks (runtime-backed in this branch).
 *
 * `dogsled doctor` exposes entity-graph serving checks for the MCP permission
 * default and generated-SDK freshness.
 *
 * Other serving checks (queue/telemetry/compile-driven checks) are deferred
 * until the related runtime surfaces are fully shipped.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { SDK_CODEGEN_VERSION, SDK_IR_VERSION } from '@bobsled-inc/sdk-codegen';

export type DoctorSeverity = 'pass' | 'warn' | 'fail';

interface BaseFinding {
  severity: DoctorSeverity;
  summary: string;
}

export interface McpUnfilteredDetails {
  allow_unfiltered: boolean;
  node_env?: string;
}

export interface McpUnfilteredFinding extends BaseFinding {
  check: 'mcp_unfiltered_in_production';
  details?: McpUnfilteredDetails;
}

export interface SdkStaleDetails {
  path: string;
  parsed_ir_version: string;
  expected_ir_version: string;
  parsed_codegen_version: string;
  expected_codegen_version: string;
}

export interface SdkStaleFinding extends BaseFinding {
  check: 'sdk_stale';
  details?: SdkStaleDetails;
}

/**
 * Discriminated union for stable JSON/YAML output contracts.
 */
export type DoctorFinding = McpUnfilteredFinding | SdkStaleFinding;

export interface McpUnfilteredCheckInput {
  env?: Record<string, string | undefined>;
}

export function checkMcpUnfilteredInProduction(input: McpUnfilteredCheckInput = {}): DoctorFinding {
  const env = input.env ?? process.env;
  const allowUnfiltered = env['DOGSLED_MCP_ALLOW_UNFILTERED'] === '1';
  const isProd = env['NODE_ENV'] === 'production';
  if (allowUnfiltered && isProd) {
    return {
      check: 'mcp_unfiltered_in_production',
      severity: 'fail',
      summary:
        'DOGSLED_MCP_ALLOW_UNFILTERED=1 is set in production. ' +
        'The MCP server runs without permission enforcement; connect only public / single-tenant data.',
      details: { allow_unfiltered: true, node_env: env['NODE_ENV'] },
    };
  }
  if (allowUnfiltered) {
    return {
      check: 'mcp_unfiltered_in_production',
      severity: 'warn',
      summary:
        'DOGSLED_MCP_ALLOW_UNFILTERED=1 is set outside production. ' +
        'Acceptable for local / single-tenant development; ensure NODE_ENV is not promoted to production with this flag still set.',
      details: { allow_unfiltered: true, node_env: env['NODE_ENV'] },
    };
  }
  return {
    check: 'mcp_unfiltered_in_production',
    severity: 'pass',
    summary: 'fail-closed MCP default is in effect.',
    details: { allow_unfiltered: false },
  };
}

export interface SdkStaleCheckInput {
  rootDir?: string;
  paths?: readonly string[];
  expectedIrVersion?: string;
  expectedCodegenVersion?: string;
}

interface ParsedSdkHeader {
  path: string;
  irVersion: string;
  codegenVersion: string;
}

const SDK_HEADER_PATTERN =
  /^(?:\/\/|#) @bobsled-inc\/sdk-codegen codegen_version=(\S+) ir_version=(\S+)$/;
const DEFAULT_SDK_SCAN_PATHS = ['generated', 'sdk'] as const;

function versionMajor(version: string): string {
  return version.split('.')[0] ?? version;
}

function versionMinorKey(version: string): string {
  const [major = '', minor = ''] = version.split('.');
  return `${major}.${minor}`;
}

function collectFiles(dir: string): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...collectFiles(path));
    } else if (stat.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function parseSdkHeaders(
  input: Required<Pick<SdkStaleCheckInput, 'rootDir' | 'paths'>>
): ParsedSdkHeader[] {
  const headers: ParsedSdkHeader[] = [];
  for (const scanPath of input.paths) {
    const abs = resolve(input.rootDir, scanPath);
    for (const file of collectFiles(abs)) {
      const firstLine = readFileSync(file, 'utf8').split(/\r?\n/, 1)[0] ?? '';
      const match = SDK_HEADER_PATTERN.exec(firstLine);
      if (!match) continue;
      headers.push({
        path: relative(input.rootDir, file),
        codegenVersion: match[1]!,
        irVersion: match[2]!,
      });
    }
  }
  return headers;
}

function sdkHeaderDetails(
  header: ParsedSdkHeader,
  expectedIrVersion: string,
  expectedCodegenVersion: string
): SdkStaleDetails {
  return {
    path: header.path,
    parsed_ir_version: header.irVersion,
    expected_ir_version: expectedIrVersion,
    parsed_codegen_version: header.codegenVersion,
    expected_codegen_version: expectedCodegenVersion,
  };
}

export function checkSdkStale(input: SdkStaleCheckInput = {}): DoctorFinding {
  const rootDir = resolve(input.rootDir ?? process.cwd());
  const paths = input.paths ?? DEFAULT_SDK_SCAN_PATHS;
  const expectedIrVersion = input.expectedIrVersion ?? SDK_IR_VERSION;
  const expectedCodegenVersion = input.expectedCodegenVersion ?? SDK_CODEGEN_VERSION;
  const headers = parseSdkHeaders({ rootDir, paths });

  if (headers.length === 0) {
    return {
      check: 'sdk_stale',
      severity: 'pass',
      summary: 'No generated SDK headers found; skipping stale-SDK check.',
    };
  }

  const irMismatch = headers.find(
    (header) => versionMajor(header.irVersion) !== versionMajor(expectedIrVersion)
  );
  if (irMismatch) {
    return {
      check: 'sdk_stale',
      severity: 'fail',
      summary:
        `Generated SDK ${irMismatch.path} targets IR ${irMismatch.irVersion}, ` +
        `but this CLI expects IR ${expectedIrVersion}. Regenerate the SDK.`,
      details: sdkHeaderDetails(irMismatch, expectedIrVersion, expectedCodegenVersion),
    };
  }

  const codegenDrift = headers.find(
    (header) => versionMinorKey(header.codegenVersion) !== versionMinorKey(expectedCodegenVersion)
  );
  if (codegenDrift) {
    return {
      check: 'sdk_stale',
      severity: 'warn',
      summary:
        `Generated SDK ${codegenDrift.path} was emitted by sdk-codegen ` +
        `${codegenDrift.codegenVersion}; current sdk-codegen is ${expectedCodegenVersion}.`,
      details: sdkHeaderDetails(codegenDrift, expectedIrVersion, expectedCodegenVersion),
    };
  }

  return {
    check: 'sdk_stale',
    severity: 'pass',
    summary: `Generated SDK headers match IR ${expectedIrVersion} and sdk-codegen ${expectedCodegenVersion}.`,
    details: sdkHeaderDetails(headers[0]!, expectedIrVersion, expectedCodegenVersion),
  };
}
