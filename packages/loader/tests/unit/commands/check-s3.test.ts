import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('checkS3', () => {
  afterEach(() => {
    vi.doUnmock('@aws-sdk/client-s3');
    vi.doUnmock('../../../src/runtime/destinations/s3.js');
    vi.restoreAllMocks();
  });

  async function loadCheckS3() {
    const { checkS3 } = await import('../../../src/commands/check.js');
    return checkS3;
  }

  function captureStderr() {
    const stderr = new PassThrough();
    let output = '';
    stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    return { stderr, getOutput: () => output };
  }

  it('succeeds when bucket is accessible', async () => {
    vi.doMock('@aws-sdk/client-s3', () => ({
      S3Client: class {
        async send() {
          return {};
        }
      },
      HeadBucketCommand: class {
        constructor(public input: Record<string, unknown>) {}
      },
    }));
    vi.doMock('../../../src/runtime/destinations/s3.js', () => ({
      buildS3ClientConfig: async () => ({}),
    }));

    const checkS3 = await loadCheckS3();
    const { stderr, getOutput } = captureStderr();

    await checkS3({ bucket: 'my-bucket', region: 'us-east-1' }, { stderr });

    expect(getOutput()).toContain('S3: bucket "my-bucket" is accessible');
  });

  it('reports failure when bucket does not exist', async () => {
    vi.doMock('@aws-sdk/client-s3', () => ({
      S3Client: class {
        async send() {
          throw new Error('NoSuchBucket: The specified bucket does not exist');
        }
      },
      HeadBucketCommand: class {
        constructor(public input: Record<string, unknown>) {}
      },
    }));
    vi.doMock('../../../src/runtime/destinations/s3.js', () => ({
      buildS3ClientConfig: async () => ({}),
    }));

    const checkS3 = await loadCheckS3();
    const { stderr, getOutput } = captureStderr();
    let exitCode: number | undefined;

    await checkS3(
      { bucket: 'missing-bucket' },
      { stderr, setExitCode: (code) => (exitCode = code) }
    );

    expect(getOutput()).toContain('NoSuchBucket');
    expect(exitCode).toBe(1);
  });

  it('reports failure when credentials are invalid', async () => {
    vi.doMock('@aws-sdk/client-s3', () => ({
      S3Client: class {
        async send() {
          throw new Error('Access Denied');
        }
      },
      HeadBucketCommand: class {
        constructor(public input: Record<string, unknown>) {}
      },
    }));
    vi.doMock('../../../src/runtime/destinations/s3.js', () => ({
      buildS3ClientConfig: async () => ({}),
    }));

    const checkS3 = await loadCheckS3();
    const { stderr, getOutput } = captureStderr();
    let exitCode: number | undefined;

    await checkS3(
      { bucket: 'restricted-bucket' },
      { stderr, setExitCode: (code) => (exitCode = code) }
    );

    expect(getOutput()).toContain('Access Denied');
    expect(exitCode).toBe(1);
  });

  it('passes region and role config through to buildS3ClientConfig', async () => {
    let capturedConfig: Record<string, unknown> | undefined;

    vi.doMock('@aws-sdk/client-s3', () => ({
      S3Client: class {
        async send() {
          return {};
        }
      },
      HeadBucketCommand: class {
        constructor(public input: Record<string, unknown>) {}
      },
    }));
    vi.doMock('../../../src/runtime/destinations/s3.js', () => ({
      buildS3ClientConfig: async (config: Record<string, unknown>) => {
        capturedConfig = config;
        return {};
      },
    }));

    const checkS3 = await loadCheckS3();
    const { stderr } = captureStderr();

    await checkS3(
      { bucket: 'my-bucket', region: 'eu-west-1', roleArn: 'arn:aws:iam::123:role/test' },
      { stderr }
    );

    expect(capturedConfig).toEqual({
      region: 'eu-west-1',
      roleArn: 'arn:aws:iam::123:role/test',
      externalId: undefined,
    });
  });
});
