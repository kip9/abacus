import { describe, it, expect } from 'vitest';
import {
  extractModelFromArn,
  extractUserFromArn,
  calculateBedrockCost,
  parseBedrockLogEntry,
  parseCsvMessage,
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
});
