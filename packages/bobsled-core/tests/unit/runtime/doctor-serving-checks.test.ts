import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkMcpUnfilteredInProduction,
  checkSdkStale,
} from '../../../src/runtime/doctor/serving-checks.js';

describe('checkMcpUnfilteredInProduction', () => {
  it('fails when both BOBSLED_CORE_MCP_ALLOW_UNFILTERED=1 and NODE_ENV=production', () => {
    const f = checkMcpUnfilteredInProduction({
      env: { BOBSLED_CORE_MCP_ALLOW_UNFILTERED: '1', NODE_ENV: 'production' },
    });
    expect(f.severity).toBe('fail');
  });

  it('warns when allow-unfiltered is set outside production', () => {
    const f = checkMcpUnfilteredInProduction({
      env: { BOBSLED_CORE_MCP_ALLOW_UNFILTERED: '1', NODE_ENV: 'development' },
    });
    expect(f.severity).toBe('warn');
  });

  it('passes when fail-closed default is in effect', () => {
    const f = checkMcpUnfilteredInProduction({ env: { NODE_ENV: 'production' } });
    expect(f.severity).toBe('pass');
  });
});

describe('checkSdkStale', () => {
  function withFixture(fn: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'bobsled-doctor-sdk-'));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  function writeGeneratedHeader(dir: string, firstLine: string): void {
    const sdkDir = join(dir, 'generated', 'entities');
    mkdirSync(sdkDir, { recursive: true });
    writeFileSync(join(sdkDir, 'Customer.ts'), `${firstLine}\nexport {};\n`);
  }

  it('passes when no generated SDK headers are present', () => {
    withFixture((dir) => {
      const finding = checkSdkStale({ rootDir: dir });
      expect(finding.severity).toBe('pass');
      expect(finding.summary).toContain('No generated SDK headers');
    });
  });

  it('passes when generated SDK headers match expected versions', () => {
    withFixture((dir) => {
      writeGeneratedHeader(dir, '// @bobsled-inc/sdk-codegen codegen_version=1.2.3 ir_version=1.0');
      const finding = checkSdkStale({
        rootDir: dir,
        expectedCodegenVersion: '1.2.4',
        expectedIrVersion: '1.0',
      });
      expect(finding.severity).toBe('pass');
      expect(finding.details).toMatchObject({
        parsed_ir_version: '1.0',
        parsed_codegen_version: '1.2.3',
      });
    });
  });

  it('fails when generated SDK IR major version is stale', () => {
    withFixture((dir) => {
      writeGeneratedHeader(dir, '// @bobsled-inc/sdk-codegen codegen_version=1.2.3 ir_version=0.9');
      const finding = checkSdkStale({
        rootDir: dir,
        expectedCodegenVersion: '1.2.3',
        expectedIrVersion: '1.0',
      });
      expect(finding.severity).toBe('fail');
      expect(finding.details).toMatchObject({
        path: 'generated/entities/Customer.ts',
        parsed_ir_version: '0.9',
        expected_ir_version: '1.0',
      });
    });
  });

  it('warns when generated SDK codegen minor version drifts', () => {
    withFixture((dir) => {
      writeGeneratedHeader(dir, '# @bobsled-inc/sdk-codegen codegen_version=1.1.9 ir_version=1.0');
      const finding = checkSdkStale({
        rootDir: dir,
        expectedCodegenVersion: '1.2.0',
        expectedIrVersion: '1.0',
      });
      expect(finding.severity).toBe('warn');
      expect(finding.details).toMatchObject({
        parsed_codegen_version: '1.1.9',
        expected_codegen_version: '1.2.0',
      });
    });
  });
});
