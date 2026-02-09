import { escapeJsonControlChars, BedrockLogEntry } from './bedrock';

/**
 * Regex to match the start of a record in Bedrock export format.
 * Matches: YYYY-MM-DDTHH:MM:SS.mmmZ followed by whitespace and opening brace.
 */
const RECORD_START_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\s+\{/;

/**
 * Parse a Bedrock CloudWatch export file into BedrockLogEntry objects.
 *
 * The export format has two whitespace-separated columns per record:
 * - Column 1: ISO timestamp with milliseconds (e.g., 2026-02-06T08:22:58.000Z)
 * - Column 2: JSON log entry (same schema as CloudWatch CSV message column)
 *
 * JSON objects may span multiple lines when body logging is enabled,
 * since string values can contain literal newlines.
 * Records are delimited by lines starting with a new timestamp.
 */
export function parseBedrockExport(content: string): BedrockLogEntry[] {
  const lines = content.split('\n');
  const entries: BedrockLogEntry[] = [];

  let currentJson = '';

  function flushRecord() {
    if (!currentJson) return;
    const sanitized = escapeJsonControlChars(currentJson);
    try {
      entries.push(JSON.parse(sanitized) as BedrockLogEntry);
    } catch {
      // Skip unparseable records
    }
    currentJson = '';
  }

  for (const line of lines) {
    const match = line.match(RECORD_START_RE);
    if (match) {
      // Flush previous record
      flushRecord();
      // Start new record: extract JSON portion (everything after timestamp + whitespace)
      const timestampEnd = line.indexOf('{');
      currentJson = line.slice(timestampEnd);
    } else if (currentJson) {
      // Continuation line (multiline JSON string value)
      currentJson += '\n' + line;
    }
  }

  // Flush last record
  flushRecord();

  return entries;
}
