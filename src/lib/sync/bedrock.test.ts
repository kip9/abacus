import { describe, it, expect } from 'vitest';
import {
  extractModelFromArn,
  extractUserFromArn,
  calculateBedrockCost,
  parseBedrockLogEntry,
  parseCsvMessage,
  parseBedrockCsv,
  BedrockLogEntry,
} from './bedrock';

describe('Bedrock Sync', () => {
  describe('extractModelFromArn', () => {
    it('extracts model from inference profile ARN', () => {
      const arn = 'arn:aws:bedrock:eu-west-3:445051798927:inference-profile/eu.anthropic.claude-haiku-4-5-20251001-v1:0';
      expect(extractModelFromArn(arn)).toBe('claude-haiku-4-5-20251001-v1:0');
    });

    it('extracts model from inference profile ARN without region prefix', () => {
      const arn = 'arn:aws:bedrock:us-east-1:123456789:inference-profile/anthropic.claude-3-sonnet-20240229-v1:0';
      expect(extractModelFromArn(arn)).toBe('claude-3-sonnet-20240229-v1:0');
    });

    it('extracts model from foundation model ARN', () => {
      const arn = 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-v2';
      expect(extractModelFromArn(arn)).toBe('claude-v2');
    });

    it('extracts model from direct model ID', () => {
      const modelId = 'anthropic.claude-3-sonnet-20240229-v1:0';
      expect(extractModelFromArn(modelId)).toBe('claude-3-sonnet-20240229-v1:0');
    });

    it('extracts model from direct model ID with region prefix', () => {
      const modelId = 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';
      expect(extractModelFromArn(modelId)).toBe('claude-haiku-4-5-20251001-v1:0');
    });

    it('returns as-is if no pattern matches', () => {
      const modelId = 'unknown-model-format';
      expect(extractModelFromArn(modelId)).toBe('unknown-model-format');
    });
  });

  describe('extractUserFromArn', () => {
    it('extracts IAM user from user ARN', () => {
      const arn = 'arn:aws:iam::445051798927:user/BedrockAPIKey-d3qp';
      expect(extractUserFromArn(arn)).toBe('BedrockAPIKey-d3qp');
    });

    it('extracts role and session from assumed role ARN', () => {
      const arn = 'arn:aws:sts::445051798927:assumed-role/MyRole/SessionName';
      expect(extractUserFromArn(arn)).toBe('MyRole/SessionName');
    });

    it('extracts role name from role ARN', () => {
      const arn = 'arn:aws:iam::445051798927:role/BedrockAccessRole';
      expect(extractUserFromArn(arn)).toBe('BedrockAccessRole');
    });

    it('returns full ARN if no pattern matches', () => {
      const arn = 'arn:aws:unknown::123456789:something/else';
      expect(extractUserFromArn(arn)).toBe('arn:aws:unknown::123456789:something/else');
    });

    it('handles user names with special characters', () => {
      const arn = 'arn:aws:iam::445051798927:user/api-key_test.user';
      expect(extractUserFromArn(arn)).toBe('api-key_test.user');
    });
  });

  describe('calculateBedrockCost', () => {
    it('calculates cost for haiku-4.5 model', () => {
      const cost = calculateBedrockCost('haiku-4.5', {
        inputTokens: 1000000, // 1M tokens
        outputTokens: 500000,  // 500K tokens
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      // Expected: (1M/1M * $1) + (500K/1M * $5) = $1 + $2.50 = $3.50
      expect(cost).toBeCloseTo(3.50, 2);
    });

    it('calculates cost for sonnet-4 model', () => {
      const cost = calculateBedrockCost('sonnet-4', {
        inputTokens: 1000000,
        outputTokens: 500000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      // Expected: (1M/1M * $3) + (500K/1M * $15) = $3 + $7.50 = $10.50
      expect(cost).toBeCloseTo(10.50, 2);
    });

    it('calculates cost for opus-4.5 model', () => {
      const cost = calculateBedrockCost('opus-4.5', {
        inputTokens: 1000000,
        outputTokens: 500000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      // Expected: (1M/1M * $15) + (500K/1M * $75) = $15 + $37.50 = $52.50
      expect(cost).toBeCloseTo(52.50, 2);
    });

    it('calculates cost with cache tokens', () => {
      const cost = calculateBedrockCost('haiku-4.5', {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 10000,
        cacheWriteTokens: 5000,
      });
      // Input: 1K/1M * $1 = $0.001
      // Output: 500/1M * $5 = $0.0025
      // CacheRead: 10K/1M * $0.10 = $0.001
      // CacheWrite: 5K/1M * $1.25 = $0.00625
      // Total = $0.01075
      expect(cost).toBeCloseTo(0.01075, 5);
    });

    it('uses default pricing for unknown models', () => {
      const cost = calculateBedrockCost('unknown-model', {
        inputTokens: 1000000,
        outputTokens: 500000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      // Uses default pricing (Sonnet tier): $3/M input, $15/M output
      expect(cost).toBeCloseTo(10.50, 2);
    });

    it('returns 0 for zero tokens', () => {
      const cost = calculateBedrockCost('haiku-4.5', {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      expect(cost).toBe(0);
    });

    it('handles small token counts correctly', () => {
      const cost = calculateBedrockCost('haiku-4.5', {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      // Input: 10/1M * $1 = $0.00001
      // Output: 5/1M * $5 = $0.000025
      // Total = $0.000035
      expect(cost).toBeCloseTo(0.000035, 6);
    });
  });

  describe('parseBedrockLogEntry', () => {
    const sampleLogEntry: BedrockLogEntry = {
      timestamp: '2026-01-31T14:27:21Z',
      accountId: '445051798927',
      region: 'eu-west-3',
      requestId: '42f63ae0-7203-4b52-9fdd-909763543f3a',
      operation: 'InvokeModelWithResponseStream',
      modelId: 'arn:aws:bedrock:eu-west-3:445051798927:inference-profile/eu.anthropic.claude-haiku-4-5-20251001-v1:0',
      identity: {
        arn: 'arn:aws:iam::445051798927:user/BedrockAPIKey-d3qp',
      },
      input: {
        inputTokenCount: 10,
        cacheReadInputTokenCount: 0,
        cacheWriteInputTokenCount: 11118,
      },
      output: {
        outputTokenCount: 436,
      },
    };

    it('parses valid CloudWatch log entry', () => {
      const record = parseBedrockLogEntry(sampleLogEntry);

      expect(record.requestId).toBe('42f63ae0-7203-4b52-9fdd-909763543f3a');
      expect(record.iamUser).toBe('BedrockAPIKey-d3qp');
      expect(record.inputTokens).toBe(10);
      expect(record.outputTokens).toBe(436);
      expect(record.cacheReadTokens).toBe(0);
      expect(record.cacheWriteTokens).toBe(11118);
      expect(record.timestamp).toEqual(new Date('2026-01-31T14:27:21Z'));
    });

    it('extracts and normalizes model name', () => {
      const record = parseBedrockLogEntry(sampleLogEntry);

      expect(record.rawModel).toBe('claude-haiku-4-5-20251001-v1:0');
      expect(record.model).toBe('haiku-4.5');
    });

    it('calculates cost correctly', () => {
      const record = parseBedrockLogEntry(sampleLogEntry);

      // Using haiku-4.5 pricing:
      // Input: 10/1M * $1 = $0.00001
      // Output: 436/1M * $5 = $0.00218
      // CacheWrite: 11118/1M * $1.25 = $0.0138975
      // Total ≈ $0.016
      expect(record.cost).toBeGreaterThan(0);
      expect(record.cost).toBeLessThan(0.02);
    });

    it('handles missing optional fields', () => {
      const entry: BedrockLogEntry = {
        ...sampleLogEntry,
        input: {
          inputTokenCount: 100,
          // cacheReadInputTokenCount and cacheWriteInputTokenCount omitted
        },
      };

      const record = parseBedrockLogEntry(entry);

      expect(record.inputTokens).toBe(100);
      expect(record.cacheReadTokens).toBe(0);
      expect(record.cacheWriteTokens).toBe(0);
    });

    it('handles error entries with no input/output fields', () => {
      // Error entries (e.g., AccessDeniedException) have no input or output
      const entry = {
        timestamp: '2026-02-08T13:41:37Z',
        accountId: '445051798927',
        region: 'eu-west-3',
        requestId: 'f7dfe505-62eb-4c0b-bd93-c415d0af38f7',
        operation: 'InvokeModelWithResponseStream',
        modelId: 'arn:aws:bedrock:eu-west-3:445051798927:inference-profile/eu.anthropic.claude-opus-4-6-v1',
        identity: { arn: 'arn:aws:iam::445051798927:user/BedrockAPIKey-dm4c' },
        errorCode: 'AccessDeniedException',
        schemaType: 'ModelInvocationLog',
        schemaVersion: '1.0',
      } as unknown as BedrockLogEntry;

      const record = parseBedrockLogEntry(entry);

      expect(record.inputTokens).toBe(0);
      expect(record.outputTokens).toBe(0);
      expect(record.cacheReadTokens).toBe(0);
      expect(record.cacheWriteTokens).toBe(0);
      expect(record.cost).toBe(0);
      expect(record.requestId).toBe('f7dfe505-62eb-4c0b-bd93-c415d0af38f7');
    });
  });

  describe('parseCsvMessage', () => {
    it('parses simple JSON message', () => {
      const message = '{"timestamp":"2026-01-31T14:27:21Z","accountId":"123","region":"us-east-1","requestId":"abc","operation":"Invoke","modelId":"model","identity":{"arn":"arn"},"input":{"inputTokenCount":10},"output":{"outputTokenCount":5}}';
      const entry = parseCsvMessage(message);

      expect(entry.timestamp).toBe('2026-01-31T14:27:21Z');
      expect(entry.requestId).toBe('abc');
    });

    it('handles quoted JSON message', () => {
      const message = '"{"timestamp":"2026-01-31T14:27:21Z","accountId":"123","region":"us-east-1","requestId":"abc","operation":"Invoke","modelId":"model","identity":{"arn":"arn"},"input":{"inputTokenCount":10},"output":{"outputTokenCount":5}}"';
      const entry = parseCsvMessage(message);

      expect(entry.timestamp).toBe('2026-01-31T14:27:21Z');
    });

    it('handles message with leading/trailing whitespace', () => {
      // CloudWatch exports may have extra whitespace
      const message = '  {"timestamp":"2026-01-31T14:27:21Z","accountId":"123","region":"us-east-1","requestId":"abc","operation":"Invoke","modelId":"model","identity":{"arn":"arn"},"input":{"inputTokenCount":10},"output":{"outputTokenCount":5}}  ';
      const entry = parseCsvMessage(message);

      expect(entry.timestamp).toBe('2026-01-31T14:27:21Z');
    });
  });

  describe('parseBedrockCsv', () => {
    const makeEntry = (overrides: Partial<BedrockLogEntry> = {}): BedrockLogEntry => ({
      timestamp: '2026-01-31T14:27:21Z',
      accountId: '445051798927',
      region: 'eu-west-3',
      requestId: 'req-001',
      operation: 'InvokeModelWithResponseStream',
      modelId: 'anthropic.claude-3-sonnet-20240229-v1:0',
      identity: { arn: 'arn:aws:iam::445051798927:user/TestUser' },
      input: { inputTokenCount: 100 },
      output: { outputTokenCount: 50 },
      ...overrides,
    });

    it('parses simple CSV with header row', () => {
      const entry = makeEntry();
      const csv = `timestamp,message\n2026-01-31T14:27:21Z,"${JSON.stringify(entry).replace(/"/g, '""')}"`;
      const entries = parseBedrockCsv(csv);

      expect(entries).toHaveLength(1);
      expect(entries[0].requestId).toBe('req-001');
      expect(entries[0].input.inputTokenCount).toBe(100);
      expect(entries[0].output.outputTokenCount).toBe(50);
    });

    it('parses CSV without header row', () => {
      const entry = makeEntry();
      const csv = `2026-01-31T14:27:21Z,"${JSON.stringify(entry).replace(/"/g, '""')}"`;
      const entries = parseBedrockCsv(csv);

      expect(entries).toHaveLength(1);
      expect(entries[0].requestId).toBe('req-001');
    });

    it('parses multiple rows', () => {
      const entry1 = makeEntry({ requestId: 'req-001' });
      const entry2 = makeEntry({ requestId: 'req-002', input: { inputTokenCount: 200 } });
      const entry3 = makeEntry({ requestId: 'req-003', output: { outputTokenCount: 300 } });

      const rows = [
        'timestamp,message',
        `2026-01-31T14:27:21Z,"${JSON.stringify(entry1).replace(/"/g, '""')}"`,
        `2026-01-31T15:00:00Z,"${JSON.stringify(entry2).replace(/"/g, '""')}"`,
        `2026-01-31T16:00:00Z,"${JSON.stringify(entry3).replace(/"/g, '""')}"`,
      ];
      const entries = parseBedrockCsv(rows.join('\n'));

      expect(entries).toHaveLength(3);
      expect(entries[0].requestId).toBe('req-001');
      expect(entries[1].requestId).toBe('req-002');
      expect(entries[1].input.inputTokenCount).toBe(200);
      expect(entries[2].requestId).toBe('req-003');
      expect(entries[2].output.outputTokenCount).toBe(300);
    });

    it('handles multi-line CSV records with embedded newlines in inputBodyJson', () => {
      const entry = makeEntry({
        requestId: 'req-multiline',
        input: {
          inputContentType: 'application/json',
          inputBodyJson: {
            messages: [{ role: 'user', content: 'line one\nline two\nline three' }],
            system: 'You are a helpful\nassistant.',
          },
          inputTokenCount: 500,
        },
        output: {
          outputContentType: 'application/json',
          outputBodyJson: { content: [{ text: 'response\nwith\nnewlines' }] },
          outputTokenCount: 200,
        },
      });

      // Build CSV the way CloudWatch exports it: JSON is quoted, internal quotes doubled
      const jsonStr = JSON.stringify(entry);
      const csvEscaped = jsonStr.replace(/"/g, '""');
      const csv = `timestamp,message\n2026-01-31T14:27:21Z,"${csvEscaped}"`;
      const entries = parseBedrockCsv(csv);

      expect(entries).toHaveLength(1);
      expect(entries[0].requestId).toBe('req-multiline');
      expect(entries[0].input.inputTokenCount).toBe(500);
      expect(entries[0].output.outputTokenCount).toBe(200);
      expect(entries[0].input.inputBodyJson).toBeDefined();
      expect(entries[0].output.outputBodyJson).toBeDefined();
    });

    it('handles body logging fields alongside token counts', () => {
      const entry = makeEntry({
        input: {
          inputContentType: 'application/json',
          inputBodyJson: { messages: [{ role: 'user', content: 'hello' }] },
          inputTokenCount: 42,
          cacheReadInputTokenCount: 10,
          cacheWriteInputTokenCount: 20,
        },
        output: {
          outputContentType: 'application/json',
          outputBodyJson: { content: [{ text: 'hi' }] },
          outputTokenCount: 15,
        },
      });

      const csv = `timestamp,message\n2026-01-31T14:27:21Z,"${JSON.stringify(entry).replace(/"/g, '""')}"`;
      const entries = parseBedrockCsv(csv);

      expect(entries).toHaveLength(1);
      const parsed = entries[0];
      expect(parsed.input.inputTokenCount).toBe(42);
      expect(parsed.input.cacheReadInputTokenCount).toBe(10);
      expect(parsed.input.cacheWriteInputTokenCount).toBe(20);
      expect(parsed.output.outputTokenCount).toBe(15);

      // Verify it still produces valid usage records
      const record = parseBedrockLogEntry(parsed);
      expect(record.inputTokens).toBe(42);
      expect(record.outputTokens).toBe(15);
      expect(record.cacheReadTokens).toBe(10);
      expect(record.cacheWriteTokens).toBe(20);
    });

    it('handles CSV double-quote escaping', () => {
      // Build a CSV where the JSON message contains quotes that get CSV-escaped
      const entry = makeEntry({ requestId: 'req-quotes' });
      const jsonStr = JSON.stringify(entry);
      // CSV standard: field is wrapped in quotes, internal quotes doubled
      const csv = `timestamp,message\n2026-01-31T14:27:21Z,"${jsonStr.replace(/"/g, '""')}"`;
      const entries = parseBedrockCsv(csv);

      expect(entries).toHaveLength(1);
      expect(entries[0].requestId).toBe('req-quotes');
    });

    it('skips rows with empty message column', () => {
      const entry = makeEntry();
      const csv = [
        'timestamp,message',
        `2026-01-31T14:27:21Z,"${JSON.stringify(entry).replace(/"/g, '""')}"`,
        '2026-01-31T15:00:00Z,',
        '2026-01-31T16:00:00Z,  ',
      ].join('\n');
      const entries = parseBedrockCsv(csv);

      expect(entries).toHaveLength(1);
      expect(entries[0].requestId).toBe('req-001');
    });

    it('detects header with "message" keyword', () => {
      const entry = makeEntry();
      const csv = `@timestamp,@message\n2026-01-31T14:27:21Z,"${JSON.stringify(entry).replace(/"/g, '""')}"`;
      const entries = parseBedrockCsv(csv);

      expect(entries).toHaveLength(1);
      expect(entries[0].requestId).toBe('req-001');
    });

    it('handles backslash followed by literal newline in content', () => {
      // Real-world case: body content has a backslash at end of line,
      // followed by a literal newline (not a JSON \\n escape sequence)
      const entry = makeEntry({
        requestId: 'req-backslash',
        input: {
          inputContentType: 'application/json',
          inputBodyJson: { messages: [{ role: 'user', content: 'path is C:\\' }] },
          inputTokenCount: 75,
        },
      });

      // Simulate what CloudWatch produces: the JSON has a literal backslash
      // before a value, and the CSV has embedded newlines
      const jsonStr = JSON.stringify(entry);
      // Replace the escaped \\n with a real backslash + literal newline
      // to simulate the CloudWatch export behavior
      const withLiteralNewline = jsonStr.replace(
        'C:\\\\',
        'C:\\\n'
      );
      const csvEscaped = withLiteralNewline.replace(/"/g, '""');
      const csv = `timestamp,message\n2026-01-31T14:27:21Z,"${csvEscaped}"`;
      const entries = parseBedrockCsv(csv);

      expect(entries).toHaveLength(1);
      expect(entries[0].requestId).toBe('req-backslash');
      expect(entries[0].input.inputTokenCount).toBe(75);
    });
  });
});
