import Papa from 'papaparse';
import { db, syncState } from '../db';
import { eq } from 'drizzle-orm';
import { normalizeModelName } from '../utils';

// ============================================================================
// Types
// ============================================================================

/**
 * Raw CloudWatch log entry from Bedrock invocation logs.
 * This is the JSON structure inside the `message` column of CloudWatch exports.
 */
export interface BedrockLogEntry {
  timestamp: string;
  accountId: string;
  region: string;
  requestId: string;
  operation: string;
  modelId: string;
  identity: {
    arn: string;
  };
  input: {
    inputContentType?: string;
    inputBodyJson?: Record<string, unknown>;
    inputTokenCount: number;
    cacheReadInputTokenCount?: number;
    cacheWriteInputTokenCount?: number;
  };
  output: {
    outputContentType?: string;
    outputBodyJson?: Record<string, unknown>;
    outputTokenCount: number;
  };
}

/**
 * Parsed/normalized record ready for insertion into usage_records.
 */
export interface BedrockUsageRecord {
  timestamp: Date;
  requestId: string;
  iamUser: string;
  rawModel: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

export interface SyncResult {
  success: boolean;
  recordsImported: number;
  recordsSkipped: number;
  errors: string[];
}

// ============================================================================
// Pricing
// ============================================================================

/**
 * Bedrock pricing per million tokens (USD).
 * Based on AWS Bedrock pricing for Anthropic models.
 */
const BEDROCK_PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'haiku-3': { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.30 },
  'haiku-3.5': { input: 0.80, output: 4.00, cacheRead: 0.08, cacheWrite: 1.00 },
  'haiku-4.5': { input: 1.00, output: 5.00, cacheRead: 0.10, cacheWrite: 1.25 },
  'sonnet-3.5': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  'sonnet-4': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  'opus-4': { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
  'opus-4.5': { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
};

// Default pricing for unknown models (use Sonnet pricing as default)
const DEFAULT_PRICING = { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 };

// ============================================================================
// Sync State
// ============================================================================

const SYNC_STATE_ID = 'bedrock';

/**
 * Get Bedrock sync state from database.
 * Uses lastSyncedHourEnd to track the last synced timestamp (epoch ms).
 */
export async function getBedrockSyncState(): Promise<{ lastSyncedTimestamp: number | null }> {
  const result = await db
    .select({ lastSyncedHourEnd: syncState.lastSyncedHourEnd })
    .from(syncState)
    .where(eq(syncState.id, SYNC_STATE_ID));

  if (result.length === 0 || !result[0].lastSyncedHourEnd) {
    return { lastSyncedTimestamp: null };
  }
  return { lastSyncedTimestamp: parseInt(result[0].lastSyncedHourEnd) };
}

/**
 * Update Bedrock sync state.
 */
export async function updateBedrockSyncState(lastSyncedTimestamp: number): Promise<void> {
  await db
    .insert(syncState)
    .values({
      id: SYNC_STATE_ID,
      lastSyncAt: new Date(),
      lastSyncedHourEnd: lastSyncedTimestamp.toString(),
    })
    .onConflictDoUpdate({
      target: syncState.id,
      set: {
        lastSyncAt: new Date(),
        lastSyncedHourEnd: lastSyncedTimestamp.toString(),
      },
    });
}

/**
 * Reset backfill complete flag (allows re-importing data).
 */
export async function resetBedrockBackfillComplete(): Promise<void> {
  await db
    .update(syncState)
    .set({ backfillComplete: false })
    .where(eq(syncState.id, SYNC_STATE_ID));
}

// ============================================================================
// ARN Parsing
// ============================================================================

/**
 * Extract model name from a Bedrock modelId ARN.
 *
 * Handles formats like:
 * - arn:aws:bedrock:eu-west-3:445051798927:inference-profile/eu.anthropic.claude-haiku-4-5-20251001-v1:0
 * - arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-v2
 * - anthropic.claude-3-sonnet-20240229-v1:0
 *
 * Returns the model portion (e.g., "claude-haiku-4-5-20251001-v1:0").
 */
export function extractModelFromArn(modelId: string): string {
  // Handle inference profile ARN format
  // arn:aws:bedrock:region:account:inference-profile/region.anthropic.model-name
  const inferenceMatch = modelId.match(/inference-profile\/(?:[a-z-]+\.)?anthropic\.(.+)$/);
  if (inferenceMatch) {
    return inferenceMatch[1];
  }

  // Handle foundation model ARN format
  // arn:aws:bedrock:region::foundation-model/anthropic.model-name
  const foundationMatch = modelId.match(/foundation-model\/anthropic\.(.+)$/);
  if (foundationMatch) {
    return foundationMatch[1];
  }

  // Handle direct model ID format
  // anthropic.claude-3-sonnet-20240229-v1:0
  const directMatch = modelId.match(/^(?:[a-z-]+\.)?anthropic\.(.+)$/);
  if (directMatch) {
    return directMatch[1];
  }

  // Return as-is if no pattern matches
  return modelId;
}

/**
 * Extract IAM user name from an identity ARN.
 *
 * Handles formats like:
 * - arn:aws:iam::445051798927:user/BedrockAPIKey-d3qp
 * - arn:aws:sts::445051798927:assumed-role/RoleName/SessionName
 * - arn:aws:iam::445051798927:role/RoleName
 *
 * Returns the user/role name (e.g., "BedrockAPIKey-d3qp").
 */
export function extractUserFromArn(identityArn: string): string {
  // Handle IAM user ARN
  // arn:aws:iam::account:user/UserName
  const userMatch = identityArn.match(/arn:aws:iam::\d+:user\/(.+)$/);
  if (userMatch) {
    return userMatch[1];
  }

  // Handle assumed role ARN
  // arn:aws:sts::account:assumed-role/RoleName/SessionName
  const assumedRoleMatch = identityArn.match(/arn:aws:sts::\d+:assumed-role\/([^/]+)\/(.+)$/);
  if (assumedRoleMatch) {
    // Return RoleName/SessionName for identification
    return `${assumedRoleMatch[1]}/${assumedRoleMatch[2]}`;
  }

  // Handle IAM role ARN
  // arn:aws:iam::account:role/RoleName
  const roleMatch = identityArn.match(/arn:aws:iam::\d+:role\/(.+)$/);
  if (roleMatch) {
    return roleMatch[1];
  }

  // Return the full ARN if no pattern matches
  return identityArn;
}

// ============================================================================
// Cost Calculation
// ============================================================================

/**
 * Calculate cost for a Bedrock request based on model and token counts.
 *
 * @param model - Normalized model name (e.g., "haiku-4.5", "sonnet-4")
 * @param tokens - Token counts for the request
 * @returns Cost in USD
 */
export function calculateBedrockCost(
  model: string,
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  }
): number {
  // Find matching pricing tier
  const pricing = BEDROCK_PRICING[model] || DEFAULT_PRICING;

  // Calculate cost (pricing is per million tokens)
  const inputCost = (tokens.inputTokens / 1_000_000) * pricing.input;
  const outputCost = (tokens.outputTokens / 1_000_000) * pricing.output;
  const cacheReadCost = (tokens.cacheReadTokens / 1_000_000) * pricing.cacheRead;
  const cacheWriteCost = (tokens.cacheWriteTokens / 1_000_000) * pricing.cacheWrite;

  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

// ============================================================================
// Log Parsing
// ============================================================================

/**
 * Parse a raw CloudWatch log entry into a normalized usage record.
 * This is the core parser that works with CloudWatch JSON format directly.
 *
 * @param log - Raw log entry from CloudWatch
 * @returns Parsed usage record ready for database insertion
 */
export function parseBedrockLogEntry(log: BedrockLogEntry): BedrockUsageRecord {
  const timestamp = new Date(log.timestamp);
  const requestId = log.requestId;
  const iamUser = extractUserFromArn(log.identity.arn);

  // Extract and normalize model
  const rawModel = extractModelFromArn(log.modelId);
  const model = normalizeModelName(rawModel);

  // Extract token counts (with defaults for optional/missing fields)
  // Error entries (e.g., AccessDeniedException) have no input/output at all
  const inputTokens = log.input?.inputTokenCount || 0;
  const outputTokens = log.output?.outputTokenCount || 0;
  const cacheReadTokens = log.input?.cacheReadInputTokenCount || 0;
  const cacheWriteTokens = log.input?.cacheWriteInputTokenCount || 0;

  // Calculate cost
  const cost = calculateBedrockCost(model, {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  });

  return {
    timestamp,
    requestId,
    iamUser,
    rawModel,
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cost,
  };
}

/**
 * Parse a CSV message field containing JSON.
 * Handles CSV escaping (doubled quotes, embedded newlines).
 *
 * @param messageJson - The JSON string from CSV message column
 * @returns Parsed BedrockLogEntry
 */
export function parseCsvMessage(messageJson: string): BedrockLogEntry {
  // CSV exports may have escaped quotes (doubled "") that need to be single
  let cleaned = messageJson;

  // Remove surrounding quotes if present
  if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
    cleaned = cleaned.slice(1, -1);
  }

  // Un-escape doubled quotes from CSV
  cleaned = cleaned.replace(/""/g, '"');

  // Parse the JSON
  return JSON.parse(cleaned) as BedrockLogEntry;
}

/**
 * Escape literal control characters inside JSON string values.
 * CloudWatch CSV exports with body logging can contain literal newlines,
 * tabs, etc. inside JSON string values (e.g., in inputBodyJson content).
 * These are invalid JSON and must be escaped before parsing.
 */
export function escapeJsonControlChars(json: string): string {
  // Replace control characters that appear inside JSON strings.
  // We walk the string tracking whether we're inside a JSON string literal.
  let result = '';
  let inString = false;
  let i = 0;
  while (i < json.length) {
    const ch = json[i];
    if (inString) {
      if (ch === '\\') {
        const next = json[i + 1];
        // Only pass through valid JSON escape sequences
        if (next && '"\\\/bfnrtu'.includes(next)) {
          result += ch + next;
          i += 2;
          continue;
        }
        // Lone backslash or invalid escape — escape the backslash itself
        result += '\\\\';
        i++;
        continue;
      }
      if (ch === '"') {
        inString = false;
        result += ch;
      } else if (ch === '\n') {
        result += '\\n';
      } else if (ch === '\r') {
        result += '\\r';
      } else if (ch === '\t') {
        result += '\\t';
      } else {
        result += ch;
      }
    } else {
      if (ch === '"') {
        inString = true;
      }
      result += ch;
    }
    i++;
  }
  return result;
}

/**
 * Parse a CloudWatch CSV export into BedrockLogEntry objects.
 * Uses papaparse to correctly handle multi-line fields and CSV escaping.
 *
 * Expected CSV format:
 * - Column 0: timestamp (ISO format)
 * - Column 1: message (JSON log entry)
 */
export function parseBedrockCsv(csvContent: string): BedrockLogEntry[] {
  const parsed = Papa.parse<string[]>(csvContent, {
    header: false,
    skipEmptyLines: true,
  });

  // Detect header row
  const startIdx =
    parsed.data.length > 0 &&
    (parsed.data[0][0]?.toLowerCase().includes('timestamp') ||
      parsed.data[0][1]?.toLowerCase().includes('message'))
      ? 1
      : 0;

  const entries: BedrockLogEntry[] = [];
  for (let i = startIdx; i < parsed.data.length; i++) {
    const row = parsed.data[i];
    if (!row || row.length < 2 || !row[1]?.trim()) continue;

    // papaparse handles CSV unquoting/unescaping, but the JSON may contain
    // literal control characters (newlines, tabs) inside string values from
    // body-logged fields like inputBodyJson. Escape them for valid JSON.
    const sanitized = escapeJsonControlChars(row[1]);
    try {
      entries.push(JSON.parse(sanitized));
    } catch {
      entries.push(parseCsvMessage(sanitized));
    }
  }
  return entries;
}
