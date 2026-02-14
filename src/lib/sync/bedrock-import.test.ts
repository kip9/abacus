import { describe, it, expect, vi, beforeEach } from 'vitest';
import { importBedrockLogEntries } from './bedrock-import';
import type { BedrockLogEntry } from './bedrock';

vi.mock('../queries', () => ({
  getIdentityMapping: vi.fn(),
  insertUsageRecord: vi.fn(),
}));

import { getIdentityMapping, insertUsageRecord } from '../queries';

const mockGetIdentityMapping = vi.mocked(getIdentityMapping);
const mockInsertUsageRecord = vi.mocked(insertUsageRecord);

function makeEntry(overrides: Partial<BedrockLogEntry> = {}): BedrockLogEntry {
  return {
    timestamp: '2026-02-06T08:22:58Z',
    accountId: '445051798927',
    region: 'eu-west-3',
    requestId: 'req-001',
    operation: 'InvokeModelWithResponseStream',
    modelId: 'arn:aws:bedrock:eu-west-3:445051798927:inference-profile/eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
    identity: { arn: 'arn:aws:iam::445051798927:user/BedrockAPIKey-fmh1' },
    input: { inputTokenCount: 100, cacheReadInputTokenCount: 500, cacheWriteInputTokenCount: 200 },
    output: { outputTokenCount: 50 },
    ...overrides,
  };
}

describe('importBedrockLogEntries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetIdentityMapping.mockResolvedValue('user@example.com');
    mockInsertUsageRecord.mockResolvedValue(undefined);
  });

  it('imports entries successfully', async () => {
    const entries = [makeEntry({ requestId: 'req-1' }), makeEntry({ requestId: 'req-2' })];

    const result = await importBedrockLogEntries(entries);

    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.unmapped).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.unmappedUsers).toEqual([]);
    expect(mockInsertUsageRecord).toHaveBeenCalledTimes(2);
  });

  it('skips entries with zero tokens', async () => {
    const entries = [
      makeEntry({
        requestId: 'req-empty',
        input: { inputTokenCount: 0 },
        output: { outputTokenCount: 0 },
      }),
    ];

    const result = await importBedrockLogEntries(entries);

    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockInsertUsageRecord).not.toHaveBeenCalled();
  });

  it('tracks unmapped users', async () => {
    mockGetIdentityMapping.mockResolvedValue(null);

    const entries = [
      makeEntry({ requestId: 'req-1', identity: { arn: 'arn:aws:iam::123:user/UserA' } }),
      makeEntry({ requestId: 'req-2', identity: { arn: 'arn:aws:iam::123:user/UserA' } }),
      makeEntry({ requestId: 'req-3', identity: { arn: 'arn:aws:iam::123:user/UserB' } }),
    ];

    const result = await importBedrockLogEntries(entries);

    expect(result.unmapped).toBe(3);
    expect(result.unmappedUsers).toEqual(expect.arrayContaining(['UserA', 'UserB']));
    expect(result.unmappedUsers).toHaveLength(2);
    expect(mockInsertUsageRecord).not.toHaveBeenCalled();
  });

  it('counts duplicate errors as skipped', async () => {
    mockInsertUsageRecord.mockRejectedValue(new Error('duplicate key value'));

    const entries = [makeEntry({ requestId: 'req-dup' })];

    const result = await importBedrockLogEntries(entries);

    expect(result.skipped).toBe(1);
    expect(result.errors).toBe(0);
  });

  it('counts other errors', async () => {
    mockInsertUsageRecord.mockRejectedValue(new Error('connection timeout'));

    const entries = [makeEntry({ requestId: 'req-err' })];

    const result = await importBedrockLogEntries(entries);

    expect(result.errors).toBe(1);
    expect(result.imported).toBe(0);
  });

  it('calls callbacks on progress', async () => {
    const onRecordProcessed = vi.fn();
    const onDateChange = vi.fn();

    const entries = [
      makeEntry({ requestId: 'req-1', timestamp: '2026-02-06T08:00:00Z' }),
      makeEntry({ requestId: 'req-2', timestamp: '2026-02-07T10:00:00Z' }),
    ];

    await importBedrockLogEntries(entries, { onRecordProcessed, onDateChange });

    expect(onRecordProcessed).toHaveBeenCalledTimes(2);
    expect(onRecordProcessed).toHaveBeenCalledWith('.');
    expect(onDateChange).toHaveBeenCalledWith('2026-02-06', true);
    expect(onDateChange).toHaveBeenCalledWith('2026-02-07', false);
  });

  it('handles empty entries array', async () => {
    const result = await importBedrockLogEntries([]);

    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.unmapped).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.unmappedUsers).toEqual([]);
  });

  it('inserts records with correct fields', async () => {
    const entries = [makeEntry({ requestId: 'req-check' })];

    await importBedrockLogEntries(entries);

    expect(mockInsertUsageRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        date: '2026-02-06',
        email: 'user@example.com',
        tool: 'bedrock',
        toolRecordId: 'req-check',
      })
    );
  });
});
