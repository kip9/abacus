import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createCloudWatchExportTask,
  waitForExportTaskCompletion,
  listExportedObjects,
  downloadAndDecompressObject,
  deleteExportedObjects,
  parseCloudWatchS3Export,
  syncBedrockFromCloudWatch,
  checkExportTaskStatus,
} from './bedrock-cloudwatch';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);

// Mock the import and sync state modules
vi.mock('./bedrock-import', () => ({
  importBedrockLogEntries: vi.fn().mockResolvedValue({
    imported: 0,
    skipped: 0,
    unmapped: 0,
    errors: 0,
    unmappedUsers: [],
  }),
}));

vi.mock('./bedrock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bedrock')>();
  return {
    ...actual,
    updateBedrockSyncState: vi.fn().mockResolvedValue(undefined),
  };
});

import { importBedrockLogEntries } from './bedrock-import';
import { updateBedrockSyncState } from './bedrock';

const mockImport = vi.mocked(importBedrockLogEntries);
const mockUpdateSync = vi.mocked(updateBedrockSyncState);

// ============================================================================
// Mock AWS Client Helpers
// ============================================================================

function mockCWClient(sendFn: (...args: unknown[]) => unknown) {
  return { send: vi.fn(sendFn) } as never;
}

function mockS3Client(sendFn: (...args: unknown[]) => unknown) {
  return { send: vi.fn(sendFn) } as never;
}

// ============================================================================
// Tests
// ============================================================================

describe('createCloudWatchExportTask', () => {
  it('returns the task ID from the API response', async () => {
    const client = mockCWClient(() => Promise.resolve({ taskId: 'task-abc-123' }));

    const taskId = await createCloudWatchExportTask(client, {
      logGroupName: '/aws/bedrock/invocation-logs',
      bucket: 'my-export-bucket',
      prefix: 'abacus-export',
      startTime: 1000,
      endTime: 2000,
    });

    expect(taskId).toBe('task-abc-123');
  });

  it('throws if the response has no taskId', async () => {
    const client = mockCWClient(() => Promise.resolve({}));

    await expect(
      createCloudWatchExportTask(client, {
        logGroupName: '/aws/bedrock/invocation-logs',
        bucket: 'bucket',
        prefix: 'prefix',
        startTime: 1000,
        endTime: 2000,
      })
    ).rejects.toThrow('CreateExportTask returned no taskId');
  });
});

describe('waitForExportTaskCompletion', () => {
  it('returns immediately when task is COMPLETED', async () => {
    const client = mockCWClient(() =>
      Promise.resolve({
        exportTasks: [{ status: { code: 'COMPLETED' } }],
      })
    );

    await expect(
      waitForExportTaskCompletion(client, 'task-1', { initialDelayMs: 10, timeoutMs: 1000 })
    ).resolves.toBeUndefined();
  });

  it('polls until COMPLETED', async () => {
    let callCount = 0;
    const client = mockCWClient(() => {
      callCount++;
      const status = callCount < 3 ? 'PENDING' : 'COMPLETED';
      return Promise.resolve({
        exportTasks: [{ status: { code: status } }],
      });
    });

    await waitForExportTaskCompletion(client, 'task-1', { initialDelayMs: 10, timeoutMs: 5000 });

    expect(callCount).toBe(3);
  });

  it('throws on FAILED status', async () => {
    const client = mockCWClient(() =>
      Promise.resolve({
        exportTasks: [{ status: { code: 'FAILED', message: 'bucket not found' } }],
      })
    );

    await expect(
      waitForExportTaskCompletion(client, 'task-1', { initialDelayMs: 10 })
    ).rejects.toThrow('Export task task-1 FAILED: bucket not found');
  });

  it('throws on CANCELLED status', async () => {
    const client = mockCWClient(() =>
      Promise.resolve({
        exportTasks: [{ status: { code: 'CANCELLED' } }],
      })
    );

    await expect(
      waitForExportTaskCompletion(client, 'task-1', { initialDelayMs: 10 })
    ).rejects.toThrow('CANCELLED');
  });

  it('throws if task is not found', async () => {
    const client = mockCWClient(() => Promise.resolve({ exportTasks: [] }));

    await expect(
      waitForExportTaskCompletion(client, 'task-missing', { initialDelayMs: 10 })
    ).rejects.toThrow('Export task task-missing not found');
  });

  it('throws on timeout', async () => {
    const client = mockCWClient(() =>
      Promise.resolve({
        exportTasks: [{ status: { code: 'RUNNING' } }],
      })
    );

    await expect(
      waitForExportTaskCompletion(client, 'task-slow', {
        initialDelayMs: 10,
        maxDelayMs: 10,
        timeoutMs: 50,
      })
    ).rejects.toThrow('timed out');
  });
});

describe('listExportedObjects', () => {
  it('returns .gz file keys', async () => {
    const client = mockS3Client(() =>
      Promise.resolve({
        Contents: [
          { Key: 'prefix/task-1/000000.gz' },
          { Key: 'prefix/task-1/000001.gz' },
        ],
        IsTruncated: false,
      })
    );

    const keys = await listExportedObjects(client, 'bucket', 'prefix/task-1');

    expect(keys).toEqual(['prefix/task-1/000000.gz', 'prefix/task-1/000001.gz']);
  });

  it('skips aws-logs-write-test markers', async () => {
    const client = mockS3Client(() =>
      Promise.resolve({
        Contents: [
          { Key: 'prefix/task-1/aws-logs-write-test' },
          { Key: 'prefix/task-1/000000.gz' },
        ],
        IsTruncated: false,
      })
    );

    const keys = await listExportedObjects(client, 'bucket', 'prefix/task-1');

    expect(keys).toEqual(['prefix/task-1/000000.gz']);
  });

  it('skips non-.gz files', async () => {
    const client = mockS3Client(() =>
      Promise.resolve({
        Contents: [
          { Key: 'prefix/task-1/readme.txt' },
          { Key: 'prefix/task-1/000000.gz' },
        ],
        IsTruncated: false,
      })
    );

    const keys = await listExportedObjects(client, 'bucket', 'prefix/task-1');

    expect(keys).toEqual(['prefix/task-1/000000.gz']);
  });

  it('handles pagination', async () => {
    let callCount = 0;
    const client = mockS3Client(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          Contents: [{ Key: 'prefix/task-1/000000.gz' }],
          IsTruncated: true,
          NextContinuationToken: 'token-2',
        });
      }
      return Promise.resolve({
        Contents: [{ Key: 'prefix/task-1/000001.gz' }],
        IsTruncated: false,
      });
    });

    const keys = await listExportedObjects(client, 'bucket', 'prefix/task-1');

    expect(keys).toEqual(['prefix/task-1/000000.gz', 'prefix/task-1/000001.gz']);
    expect(callCount).toBe(2);
  });

  it('handles empty response', async () => {
    const client = mockS3Client(() =>
      Promise.resolve({ Contents: undefined, IsTruncated: false })
    );

    const keys = await listExportedObjects(client, 'bucket', 'prefix/task-1');

    expect(keys).toEqual([]);
  });
});

describe('downloadAndDecompressObject', () => {
  it('decompresses gzipped content', async () => {
    const original = '1707206578000 {"requestId":"req-1"}';
    const compressed = await gzipAsync(Buffer.from(original));

    const client = mockS3Client(() =>
      Promise.resolve({
        Body: { transformToByteArray: () => Promise.resolve(new Uint8Array(compressed)) },
      })
    );

    const result = await downloadAndDecompressObject(client, 'bucket', 'key.gz');

    expect(result).toBe(original);
  });

  it('throws if Body is missing', async () => {
    const client = mockS3Client(() => Promise.resolve({ Body: undefined }));

    await expect(
      downloadAndDecompressObject(client, 'bucket', 'key.gz')
    ).rejects.toThrow('S3 object key.gz has no body');
  });
});

describe('deleteExportedObjects', () => {
  it('deletes objects in a single batch', async () => {
    const sendFn = vi.fn().mockResolvedValue({});
    const client = mockS3Client(sendFn);

    await deleteExportedObjects(client, 'bucket', ['key1.gz', 'key2.gz']);

    expect(sendFn).toHaveBeenCalledTimes(1);
  });

  it('does nothing for empty key list', async () => {
    const sendFn = vi.fn();
    const client = mockS3Client(sendFn);

    await deleteExportedObjects(client, 'bucket', []);

    expect(sendFn).not.toHaveBeenCalled();
  });
});

describe('parseCloudWatchS3Export', () => {
  const sampleEntry = {
    timestamp: '2026-02-06T08:22:58Z',
    accountId: '445051798927',
    region: 'eu-west-3',
    requestId: 'req-001',
    operation: 'InvokeModelWithResponseStream',
    modelId: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
    identity: { arn: 'arn:aws:iam::445051798927:user/TestUser' },
    input: { inputTokenCount: 100 },
    output: { outputTokenCount: 50 },
  };

  it('parses entries with ISO timestamps', () => {
    const content = `2026-02-06T08:22:58.000Z ${JSON.stringify(sampleEntry)}`;
    const entries = parseCloudWatchS3Export(content);

    expect(entries).toHaveLength(1);
    expect(entries[0].requestId).toBe('req-001');
  });

  it('parses multiple entries', () => {
    const entry2 = { ...sampleEntry, requestId: 'req-002' };
    const content = [
      `2026-02-06T08:22:58.000Z ${JSON.stringify(sampleEntry)}`,
      `2026-02-06T08:25:00.000Z ${JSON.stringify(entry2)}`,
    ].join('\n');

    const entries = parseCloudWatchS3Export(content);

    expect(entries).toHaveLength(2);
    expect(entries[0].requestId).toBe('req-001');
    expect(entries[1].requestId).toBe('req-002');
  });

  it('handles multiline JSON', () => {
    const entry = {
      ...sampleEntry,
      requestId: 'req-multiline',
      input: {
        inputContentType: 'application/json',
        inputBodyJson: {
          messages: [{ role: 'user', content: 'line one\nline two' }],
        },
        inputTokenCount: 100,
      },
    };
    // Simulate literal newlines in string values
    const jsonStr = JSON.stringify(entry).replace(/\\n/g, '\n');
    const content = `2026-02-06T08:22:58.000Z ${jsonStr}`;

    const entries = parseCloudWatchS3Export(content);

    expect(entries).toHaveLength(1);
    expect(entries[0].requestId).toBe('req-multiline');
  });

  it('handles empty content', () => {
    expect(parseCloudWatchS3Export('')).toHaveLength(0);
  });

  it('skips unparseable records', () => {
    const content = [
      '2026-02-06T08:22:58.000Z {invalid json',
      `2026-02-06T08:25:00.000Z ${JSON.stringify(sampleEntry)}`,
    ].join('\n');

    const entries = parseCloudWatchS3Export(content);

    expect(entries).toHaveLength(1);
    expect(entries[0].requestId).toBe('req-001');
  });
});

describe('checkExportTaskStatus', () => {
  it('returns the current status', async () => {
    const client = mockCWClient(() =>
      Promise.resolve({
        exportTasks: [{ status: { code: 'RUNNING', message: 'in progress' } }],
      })
    );

    const result = await checkExportTaskStatus(client, 'task-1');

    expect(result).toEqual({ status: 'RUNNING', message: 'in progress' });
  });

  it('returns null if task not found', async () => {
    const client = mockCWClient(() => Promise.resolve({ exportTasks: [] }));

    const result = await checkExportTaskStatus(client, 'task-missing');

    expect(result).toBeNull();
  });
});

describe('syncBedrockFromCloudWatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockImport.mockResolvedValue({
      imported: 5,
      skipped: 1,
      unmapped: 0,
      errors: 0,
      unmappedUsers: [],
    });
  });

  it('orchestrates the full sync pipeline', async () => {
    const sampleEntry = {
      timestamp: '2026-02-06T08:22:58Z',
      accountId: '445051798927',
      region: 'eu-west-3',
      requestId: 'req-001',
      operation: 'InvokeModelWithResponseStream',
      modelId: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
      identity: { arn: 'arn:aws:iam::445051798927:user/TestUser' },
      input: { inputTokenCount: 100 },
      output: { outputTokenCount: 50 },
    };

    const fileContent = `2026-02-06T08:22:58.000Z ${JSON.stringify(sampleEntry)}`;
    const compressed = await gzipAsync(Buffer.from(fileContent));

    // CW client: create task, then describe as COMPLETED
    const cwSend = vi.fn()
      .mockResolvedValueOnce({ taskId: 'task-xyz' })
      .mockResolvedValueOnce({ exportTasks: [{ status: { code: 'COMPLETED' } }] });
    const cwClient = { send: cwSend } as never;

    // S3 client: list objects, get object, delete objects
    const s3Send = vi.fn()
      .mockResolvedValueOnce({
        Contents: [{ Key: 'abacus-export/task-xyz/000000.gz' }],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({
        Body: { transformToByteArray: () => Promise.resolve(new Uint8Array(compressed)) },
      })
      .mockResolvedValueOnce({});
    const s3Client = { send: s3Send } as never;

    const messages: string[] = [];
    const result = await syncBedrockFromCloudWatch({
      logGroupName: '/aws/bedrock/invocation-logs',
      bucket: 'my-bucket',
      prefix: 'abacus-export',
      startTime: 1000,
      endTime: 2000,
      cwClient,
      s3Client,
      onProgress: (msg) => messages.push(msg),
    });

    expect(result.taskId).toBe('task-xyz');
    expect(result.filesProcessed).toBe(1);
    expect(result.importResult.imported).toBe(5);
    expect(mockImport).toHaveBeenCalledTimes(1);
    expect(mockUpdateSync).toHaveBeenCalledWith(2000);
    // S3 cleanup should have been called
    expect(s3Send).toHaveBeenCalledTimes(3);
    expect(messages).toContain('Creating CloudWatch export task...');
    expect(messages).toContain('Export completed.');
  });

  it('skips S3 cleanup when skipCleanup is true', async () => {
    const cwSend = vi.fn()
      .mockResolvedValueOnce({ taskId: 'task-no-cleanup' })
      .mockResolvedValueOnce({ exportTasks: [{ status: { code: 'COMPLETED' } }] });
    const cwClient = { send: cwSend } as never;

    const s3Send = vi.fn()
      .mockResolvedValueOnce({ Contents: [], IsTruncated: false });
    const s3Client = { send: s3Send } as never;

    mockImport.mockResolvedValueOnce({
      imported: 0, skipped: 0, unmapped: 0, errors: 0, unmappedUsers: [],
    });

    const result = await syncBedrockFromCloudWatch({
      logGroupName: '/aws/bedrock/invocation-logs',
      bucket: 'bucket',
      prefix: 'prefix',
      startTime: 1000,
      endTime: 2000,
      skipCleanup: true,
      cwClient,
      s3Client,
    });

    expect(result.filesProcessed).toBe(0);
    // Only list call, no delete
    expect(s3Send).toHaveBeenCalledTimes(1);
  });

  it('does not update sync state when nothing was imported', async () => {
    const cwSend = vi.fn()
      .mockResolvedValueOnce({ taskId: 'task-empty' })
      .mockResolvedValueOnce({ exportTasks: [{ status: { code: 'COMPLETED' } }] });
    const cwClient = { send: cwSend } as never;

    const s3Send = vi.fn()
      .mockResolvedValueOnce({ Contents: [], IsTruncated: false });
    const s3Client = { send: s3Send } as never;

    mockImport.mockResolvedValueOnce({
      imported: 0, skipped: 0, unmapped: 0, errors: 0, unmappedUsers: [],
    });

    await syncBedrockFromCloudWatch({
      logGroupName: '/aws/bedrock/invocation-logs',
      bucket: 'bucket',
      prefix: 'prefix',
      startTime: 1000,
      endTime: 2000,
      cwClient,
      s3Client,
    });

    expect(mockUpdateSync).not.toHaveBeenCalled();
  });
});
