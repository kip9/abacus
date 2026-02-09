import { describe, it, expect } from 'vitest';
import { parseBedrockExport } from './bedrock-export';
import { BedrockLogEntry, parseBedrockLogEntry } from './bedrock';

describe('Bedrock Export Parser', () => {
  const makeEntry = (overrides: Partial<BedrockLogEntry> = {}): BedrockLogEntry => ({
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
  });

  function makeExportLine(timestamp: string, entry: BedrockLogEntry): string {
    return `${timestamp} ${JSON.stringify(entry)}`;
  }

  describe('parseBedrockExport', () => {
    it('parses a single record', () => {
      const entry = makeEntry();
      const content = makeExportLine('2026-02-06T08:22:58.000Z', entry);
      const entries = parseBedrockExport(content);

      expect(entries).toHaveLength(1);
      expect(entries[0].requestId).toBe('req-001');
      expect(entries[0].input.inputTokenCount).toBe(100);
      expect(entries[0].output.outputTokenCount).toBe(50);
    });

    it('parses multiple records', () => {
      const entry1 = makeEntry({ requestId: 'req-001' });
      const entry2 = makeEntry({ requestId: 'req-002', input: { inputTokenCount: 200 } });
      const entry3 = makeEntry({ requestId: 'req-003', output: { outputTokenCount: 300 } });

      const content = [
        makeExportLine('2026-02-06T08:22:58.000Z', entry1),
        makeExportLine('2026-02-06T08:25:19.000Z', entry2),
        makeExportLine('2026-02-06T09:00:00.000Z', entry3),
      ].join('\n');

      const entries = parseBedrockExport(content);

      expect(entries).toHaveLength(3);
      expect(entries[0].requestId).toBe('req-001');
      expect(entries[1].requestId).toBe('req-002');
      expect(entries[1].input.inputTokenCount).toBe(200);
      expect(entries[2].requestId).toBe('req-003');
      expect(entries[2].output.outputTokenCount).toBe(300);
    });

    it('handles multiline JSON with literal newlines in string values', () => {
      const entry = makeEntry({
        requestId: 'req-multiline',
        input: {
          inputContentType: 'application/json',
          inputBodyJson: {
            messages: [{ role: 'user', content: 'line one\nline two\nline three' }],
          },
          inputTokenCount: 500,
        },
      });

      // Simulate export format: JSON with literal newlines in string values
      const jsonStr = JSON.stringify(entry);
      // Replace escaped \n with actual newlines to simulate what the export produces
      const withLiteralNewlines = jsonStr.replace(/\\n/g, '\n');
      const content = `2026-02-06T08:22:58.000Z ${withLiteralNewlines}`;

      const entries = parseBedrockExport(content);

      expect(entries).toHaveLength(1);
      expect(entries[0].requestId).toBe('req-multiline');
      expect(entries[0].input.inputTokenCount).toBe(500);
    });

    it('handles multiline JSON followed by another record', () => {
      const entry1 = makeEntry({
        requestId: 'req-multiline',
        input: {
          inputContentType: 'application/json',
          inputBodyJson: {
            messages: [{ role: 'user', content: 'hello\nworld' }],
          },
          inputTokenCount: 100,
        },
      });
      const entry2 = makeEntry({ requestId: 'req-after' });

      const json1 = JSON.stringify(entry1).replace(/\\n/g, '\n');
      const content = `2026-02-06T08:22:58.000Z ${json1}\n${makeExportLine('2026-02-06T09:00:00.000Z', entry2)}`;

      const entries = parseBedrockExport(content);

      expect(entries).toHaveLength(2);
      expect(entries[0].requestId).toBe('req-multiline');
      expect(entries[1].requestId).toBe('req-after');
    });

    it('handles empty content', () => {
      expect(parseBedrockExport('')).toHaveLength(0);
    });

    it('handles content with no valid records', () => {
      const content = 'some random text\nanother line\n';
      expect(parseBedrockExport(content)).toHaveLength(0);
    });

    it('skips unparseable JSON', () => {
      const entry = makeEntry({ requestId: 'req-good' });
      const content = [
        '2026-02-06T08:22:58.000Z {invalid json here',
        makeExportLine('2026-02-06T09:00:00.000Z', entry),
      ].join('\n');

      const entries = parseBedrockExport(content);

      expect(entries).toHaveLength(1);
      expect(entries[0].requestId).toBe('req-good');
    });

    it('handles trailing newline', () => {
      const entry = makeEntry();
      const content = makeExportLine('2026-02-06T08:22:58.000Z', entry) + '\n';
      const entries = parseBedrockExport(content);

      expect(entries).toHaveLength(1);
      expect(entries[0].requestId).toBe('req-001');
    });

    it('preserves all fields needed for parseBedrockLogEntry', () => {
      const entry = makeEntry({
        input: {
          inputTokenCount: 42,
          cacheReadInputTokenCount: 10,
          cacheWriteInputTokenCount: 20,
        },
        output: { outputTokenCount: 15 },
      });

      const content = makeExportLine('2026-02-06T08:22:58.000Z', entry);
      const entries = parseBedrockExport(content);
      const record = parseBedrockLogEntry(entries[0]);

      expect(record.inputTokens).toBe(42);
      expect(record.outputTokens).toBe(15);
      expect(record.cacheReadTokens).toBe(10);
      expect(record.cacheWriteTokens).toBe(20);
      expect(record.iamUser).toBe('BedrockAPIKey-fmh1');
      expect(record.model).toBe('sonnet-4.5');
    });

    it('handles error entries with no input/output fields', () => {
      const errorEntry = {
        timestamp: '2026-02-08T13:41:37Z',
        accountId: '445051798927',
        region: 'eu-west-3',
        requestId: 'req-error',
        operation: 'InvokeModelWithResponseStream',
        modelId: 'arn:aws:bedrock:eu-west-3:445051798927:inference-profile/eu.anthropic.claude-opus-4-6-v1',
        identity: { arn: 'arn:aws:iam::445051798927:user/BedrockAPIKey-dm4c' },
        errorCode: 'AccessDeniedException',
        schemaType: 'ModelInvocationLog',
        schemaVersion: '1.0',
      };
      const goodEntry = makeEntry({ requestId: 'req-good' });

      const content = [
        `2026-02-08T13:41:37.000Z ${JSON.stringify(errorEntry)}`,
        makeExportLine('2026-02-08T14:00:00.000Z', goodEntry),
      ].join('\n');

      const entries = parseBedrockExport(content);
      expect(entries).toHaveLength(2);

      // Error entry should parse without crashing
      const record = parseBedrockLogEntry(entries[0] as BedrockLogEntry);
      expect(record.inputTokens).toBe(0);
      expect(record.outputTokens).toBe(0);
      expect(record.cost).toBe(0);

      // Good entry should still work
      expect(entries[1].requestId).toBe('req-good');
    });

    it('handles body logging with complex nested JSON', () => {
      const entry = makeEntry({
        requestId: 'req-body',
        input: {
          inputContentType: 'application/json',
          inputBodyJson: {
            messages: [
              { role: 'user', content: [{ type: 'text', text: 'Run this command:\nexport FOO=bar && echo "done"' }] },
            ],
            system: [{ type: 'text', text: 'You are helpful.\nBe concise.' }],
          },
          inputTokenCount: 1000,
          cacheReadInputTokenCount: 5000,
        },
        output: {
          outputContentType: 'application/json',
          outputBodyJson: { content: [{ text: 'Sure!\nHere is the result.' }] },
          outputTokenCount: 200,
        },
      });

      // Simulate literal newlines in string values
      const jsonStr = JSON.stringify(entry).replace(/\\n/g, '\n');
      const content = `2026-02-06T08:22:58.000Z ${jsonStr}`;

      const entries = parseBedrockExport(content);

      expect(entries).toHaveLength(1);
      expect(entries[0].requestId).toBe('req-body');
      expect(entries[0].input.inputTokenCount).toBe(1000);
      expect(entries[0].input.cacheReadInputTokenCount).toBe(5000);
      expect(entries[0].output.outputTokenCount).toBe(200);
    });
  });
});
