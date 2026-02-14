import { parseBedrockLogEntry, BedrockLogEntry } from './bedrock';
import { insertUsageRecord, getIdentityMapping } from '../queries';

export interface ImportResult {
  imported: number;
  skipped: number;
  unmapped: number;
  errors: number;
  unmappedUsers: string[];
}

export interface ImportCallbacks {
  onProgress?: (message: string) => void;
  onRecordProcessed?: (char: string) => void;
  onDateChange?: (date: string, isFirst: boolean) => void;
}

/**
 * Import parsed Bedrock log entries into the database.
 *
 * Handles identity mapping lookups, duplicate detection, and zero-token skipping.
 * This is the shared core used by both CLI import commands and the automated sync.
 */
export async function importBedrockLogEntries(
  logEntries: readonly BedrockLogEntry[],
  callbacks?: ImportCallbacks
): Promise<ImportResult> {
  let imported = 0;
  let skipped = 0;
  let unmapped = 0;
  let errors = 0;
  let lastDate = '';
  const unmappedUsersSet = new Set<string>();

  for (const logEntry of logEntries) {
    try {
      const record = parseBedrockLogEntry(logEntry);

      const totalTokens =
        record.inputTokens + record.outputTokens + record.cacheReadTokens + record.cacheWriteTokens;
      if (totalTokens === 0) {
        skipped++;
        continue;
      }

      const email = await getIdentityMapping('bedrock', record.iamUser);
      if (!email) {
        unmapped++;
        unmappedUsersSet.add(record.iamUser);
        continue;
      }

      const date = record.timestamp.toISOString().split('T')[0];

      if (date !== lastDate) {
        callbacks?.onDateChange?.(date, lastDate === '');
        lastDate = date;
      }

      await insertUsageRecord({
        date,
        email,
        tool: 'bedrock',
        model: record.model,
        rawModel: record.rawModel,
        inputTokens: record.inputTokens,
        cacheWriteTokens: record.cacheWriteTokens,
        cacheReadTokens: record.cacheReadTokens,
        outputTokens: record.outputTokens,
        cost: record.cost,
        toolRecordId: record.requestId,
        timestampMs: record.timestamp.getTime(),
      });

      imported++;
      callbacks?.onRecordProcessed?.('.');
    } catch (err) {
      if (err instanceof Error && err.message.includes('duplicate')) {
        skipped++;
        callbacks?.onRecordProcessed?.('s');
      } else {
        errors++;
        callbacks?.onRecordProcessed?.('E');
        if (errors <= 5) {
          callbacks?.onProgress?.(`Error on entry: ${err}`);
        }
      }
    }
  }

  return {
    imported,
    skipped,
    unmapped,
    errors,
    unmappedUsers: [...unmappedUsersSet],
  };
}
