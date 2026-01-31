import * as fs from 'fs';
import { getBedrockSyncState, parseBedrockLogEntry, parseCsvMessage, BedrockLogEntry } from '../../src/lib/sync/bedrock';
import { insertUsageRecord, getIdentityMapping, setIdentityMapping, getIdentityMappings } from '../../src/lib/queries';
import { db, usageRecords } from '../../src/lib/db';
import { eq, sql } from 'drizzle-orm';

export async function cmdBedrockStatus() {
  console.log('Bedrock Sync Status\n');

  const { lastSyncedTimestamp } = await getBedrockSyncState();

  if (lastSyncedTimestamp) {
    const lastSyncDate = new Date(lastSyncedTimestamp);
    console.log(`Last synced timestamp: ${lastSyncDate.toISOString()}`);
  } else {
    console.log('Never synced');
    console.log('\nImport CloudWatch logs: pnpm cli import:bedrock-csv <path-to-csv>');
  }

  // Show record count
  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(usageRecords)
    .where(eq(usageRecords.tool, 'bedrock'));

  console.log(`\nTotal Bedrock records: ${countResult[0]?.count || 0}`);
}

/**
 * Import Bedrock usage from CloudWatch CSV export.
 *
 * Expected CSV format:
 * - Column 1: timestamp (ISO format)
 * - Column 2: message (JSON log entry)
 */
export async function cmdImportBedrockCsv(filePath: string) {
  console.log(`Importing Bedrock CSV: ${filePath}\n`);

  if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    return;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  // Parse header
  const headerLine = lines[0];
  const hasHeader = headerLine.toLowerCase().includes('timestamp') || headerLine.toLowerCase().includes('message');

  const startLine = hasHeader ? 1 : 0;
  console.log(`Total rows: ${lines.length - startLine}\n`);

  let imported = 0;
  let skipped = 0;
  let unmapped = 0;
  let errors = 0;
  let lastDate = '';
  const unmappedUsers = new Set<string>();

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    try {
      // Parse CSV line - handle quoted JSON with embedded commas
      let messageJson: string;

      // Find the first comma that separates timestamp from message
      const firstComma = line.indexOf(',');
      if (firstComma === -1) {
        skipped++;
        continue;
      }

      messageJson = line.slice(firstComma + 1);

      // Parse the JSON message
      let logEntry: BedrockLogEntry;
      try {
        logEntry = parseCsvMessage(messageJson);
      } catch {
        // Try direct JSON parse if CSV parsing fails
        logEntry = JSON.parse(messageJson);
      }

      // Parse into usage record
      const record = parseBedrockLogEntry(logEntry);

      // Skip records with no tokens
      const totalTokens = record.inputTokens + record.outputTokens + record.cacheReadTokens + record.cacheWriteTokens;
      if (totalTokens === 0) {
        skipped++;
        continue;
      }

      // Look up email mapping
      const email = await getIdentityMapping('bedrock', record.iamUser);
      if (!email) {
        unmapped++;
        unmappedUsers.add(record.iamUser);
        continue;
      }

      const date = record.timestamp.toISOString().split('T')[0];

      if (date !== lastDate) {
        if (lastDate) {
          process.stdout.write('\n');
        }
        process.stdout.write(`  ${date}: `);
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
      process.stdout.write('.');
    } catch (err) {
      if (err instanceof Error && err.message.includes('duplicate')) {
        skipped++;
        process.stdout.write('s');
      } else {
        errors++;
        process.stdout.write('E');
        if (errors <= 5) {
          console.error(`\nError on line ${i + 1}:`, err);
        }
      }
    }
  }

  console.log(`\n\nImport complete!`);
  console.log(`  Imported: ${imported}`);
  console.log(`  Skipped (duplicates/empty): ${skipped}`);
  console.log(`  Unmapped users: ${unmapped}`);
  console.log(`  Errors: ${errors}`);

  if (unmappedUsers.size > 0) {
    console.log(`\nUnmapped IAM users found:`);
    for (const user of unmappedUsers) {
      console.log(`  - ${user}`);
    }
    console.log(`\nMap users with: pnpm cli bedrock:users:map <iam-user> <email>`);
    console.log(`Then re-import to attribute records.`);
  }
}

/**
 * List IAM users found in Bedrock records and their mapping status.
 */
export async function cmdBedrockUsers() {
  console.log('Bedrock IAM User Mappings\n');

  // Get existing mappings
  const mappings = await getIdentityMappings('bedrock');
  const mappingMap = new Map(mappings.map(m => [m.external_id, m.email]));

  // Get unique IAM users from tool_record_id (which contains requestId)
  // We need to look at identity_mappings for bedrock source
  const result = await db.execute<{ iamUser: string; requestCount: number }>(sql`
    SELECT
      external_id as "iamUser",
      email
    FROM identity_mappings
    WHERE source = 'bedrock'
    ORDER BY external_id
  `);

  if (result.rows.length === 0 && mappings.length === 0) {
    console.log('No Bedrock users found.');
    console.log('\nImport logs first: pnpm cli import:bedrock-csv <path-to-csv>');
    return;
  }

  console.log('Mapped users:');
  if (mappings.length === 0) {
    console.log('  (none)');
  } else {
    for (const mapping of mappings) {
      console.log(`  ${mapping.external_id} -> ${mapping.email}`);
    }
  }

  console.log('\n---');
  console.log('\nTo add a mapping: pnpm cli bedrock:users:map <iam-user> <email>');
}

/**
 * Map an IAM user to an email address.
 */
export async function cmdBedrockUsersMap(iamUser: string, email: string) {
  if (!iamUser || !email) {
    console.error('Usage: pnpm cli bedrock:users:map <iam-user> <email>');
    return;
  }

  if (!email.includes('@')) {
    console.error('Error: Invalid email address');
    return;
  }

  await setIdentityMapping('bedrock', iamUser, email);
  console.log(`Mapped ${iamUser} -> ${email}`);
  console.log('\nRe-run import to attribute existing records: pnpm cli import:bedrock-csv <file>');
}
