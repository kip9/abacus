import * as fs from 'fs';
import { getBedrockSyncState, parseBedrockLogEntry, parseBedrockCsv } from '../../src/lib/sync/bedrock';
import { parseBedrockExport } from '../../src/lib/sync/bedrock-export';
import { insertUsageRecord, getIdentityMapping, setIdentityMapping, getIdentityMappings } from '../../src/lib/queries';

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

  // Show mapped users
  const mappings = await getIdentityMappings('bedrock');
  console.log(`\nMapped IAM users: ${mappings.length}`);
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
  const logEntries = parseBedrockCsv(content);

  console.log(`Total rows: ${logEntries.length}\n`);

  let imported = 0;
  let skipped = 0;
  let unmapped = 0;
  let errors = 0;
  let lastDate = '';
  const unmappedUsers = new Set<string>();

  for (const logEntry of logEntries) {
    try {
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
          console.error(`\nError on entry:`, err);
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

  if (mappings.length === 0) {
    console.log('No Bedrock user mappings found.');
    console.log('\nAdd a mapping: pnpm cli bedrock:users:map <iam-user> <email>');
    console.log('Then import logs: pnpm cli import:bedrock-csv <path-to-csv>');
    return;
  }

  console.log('Mapped users:');
  for (const mapping of mappings) {
    console.log(`  ${mapping.external_id} -> ${mapping.email}`);
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

/**
 * Import Bedrock usage from CloudWatch export file.
 *
 * Expected format: whitespace-separated columns per record:
 * - Column 1: ISO timestamp with milliseconds (e.g., 2026-02-06T08:22:58.000Z)
 * - Column 2: JSON log entry (may span multiple lines)
 */
export async function cmdImportBedrockExport(filePath: string) {
  console.log(`Importing Bedrock export: ${filePath}\n`);

  if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    return;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const logEntries = parseBedrockExport(content);

  console.log(`Total rows: ${logEntries.length}\n`);

  let imported = 0;
  let skipped = 0;
  let unmapped = 0;
  let errors = 0;
  let lastDate = '';
  const unmappedUsers = new Set<string>();

  for (const logEntry of logEntries) {
    try {
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
          console.error(`\nError on entry:`, err);
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
