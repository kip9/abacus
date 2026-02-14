import * as fs from 'fs';
import { getBedrockSyncState, parseBedrockCsv } from '../../src/lib/sync/bedrock';
import { parseBedrockExport } from '../../src/lib/sync/bedrock-export';
import { importBedrockLogEntries } from '../../src/lib/sync/bedrock-import';
import { syncBedrockFromCloudWatch } from '../../src/lib/sync/bedrock-cloudwatch';
import { setIdentityMapping, getIdentityMappings } from '../../src/lib/queries';

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

/** CLI callbacks for displaying import progress inline. */
function cliImportCallbacks() {
  return {
    onProgress: (msg: string) => console.error(`\n${msg}`),
    onRecordProcessed: (char: string) => process.stdout.write(char),
    onDateChange: (date: string, isFirst: boolean) => {
      if (!isFirst) {
        process.stdout.write('\n');
      }
      process.stdout.write(`  ${date}: `);
    },
  };
}

/** Print the summary after an import completes. */
function printImportSummary(result: { imported: number; skipped: number; unmapped: number; errors: number; unmappedUsers: string[] }) {
  console.log(`\n\nImport complete!`);
  console.log(`  Imported: ${result.imported}`);
  console.log(`  Skipped (duplicates/empty): ${result.skipped}`);
  console.log(`  Unmapped users: ${result.unmapped}`);
  console.log(`  Errors: ${result.errors}`);

  if (result.unmappedUsers.length > 0) {
    console.log(`\nUnmapped IAM users found:`);
    for (const user of result.unmappedUsers) {
      console.log(`  - ${user}`);
    }
    console.log(`\nMap users with: pnpm cli bedrock:users:map <iam-user> <email>`);
    console.log(`Then re-import to attribute records.`);
  }
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

  const result = await importBedrockLogEntries(logEntries, cliImportCallbacks());
  printImportSummary(result);
}

/**
 * List IAM users found in Bedrock records and their mapping status.
 */
export async function cmdBedrockUsers() {
  console.log('Bedrock IAM User Mappings\n');

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

  const result = await importBedrockLogEntries(logEntries, cliImportCallbacks());
  printImportSummary(result);
}

/**
 * Sync Bedrock usage from CloudWatch via automated export.
 *
 * Creates a CloudWatch Logs export task, waits for completion,
 * downloads the exported files from S3, and imports them.
 */
export async function cmdBedrockSync(options: {
  days?: number;
  from?: string;
  to?: string;
  skipCleanup?: boolean;
}) {
  // Validate required env vars
  if (!process.env.AWS_BEDROCK_LOG_GROUP) {
    console.error('Error: AWS_BEDROCK_LOG_GROUP environment variable is required');
    console.error('Set it to your CloudWatch log group (e.g., /aws/bedrock/invocation-logs)');
    return;
  }
  if (!process.env.AWS_BEDROCK_EXPORT_BUCKET) {
    console.error('Error: AWS_BEDROCK_EXPORT_BUCKET environment variable is required');
    console.error('Set it to your S3 bucket for exports');
    return;
  }

  // Determine time range
  const now = Date.now();
  let startTime: number;
  let endTime: number;

  if (options.from) {
    startTime = new Date(options.from).getTime();
    endTime = options.to ? new Date(options.to).getTime() : now;
  } else if (options.days) {
    startTime = now - options.days * 24 * 60 * 60 * 1000;
    endTime = now;
  } else {
    // Use last sync timestamp, or default to 7 days ago
    const { lastSyncedTimestamp } = await getBedrockSyncState();
    startTime = lastSyncedTimestamp ?? now - 7 * 24 * 60 * 60 * 1000;
    endTime = now;
  }

  console.log('Bedrock CloudWatch Sync');
  console.log(`  Log group: ${process.env.AWS_BEDROCK_LOG_GROUP}`);
  console.log(`  S3 bucket: ${process.env.AWS_BEDROCK_EXPORT_BUCKET}`);
  console.log(`  Range: ${new Date(startTime).toISOString()} → ${new Date(endTime).toISOString()}`);
  console.log('');

  try {
    const result = await syncBedrockFromCloudWatch({
      logGroupName: process.env.AWS_BEDROCK_LOG_GROUP,
      bucket: process.env.AWS_BEDROCK_EXPORT_BUCKET,
      prefix: process.env.AWS_BEDROCK_EXPORT_PREFIX || 'abacus-export',
      startTime,
      endTime,
      skipCleanup: options.skipCleanup,
      onProgress: (msg) => console.log(msg),
    });

    console.log('\nSync complete!');
    console.log(`  Files processed: ${result.filesProcessed}`);
    console.log(`  Records imported: ${result.importResult.imported}`);
    console.log(`  Records skipped: ${result.importResult.skipped}`);
    console.log(`  Unmapped users: ${result.importResult.unmapped}`);
    console.log(`  Errors: ${result.importResult.errors}`);

    if (result.importResult.unmappedUsers.length > 0) {
      console.log(`\nUnmapped IAM users:`);
      for (const user of result.importResult.unmappedUsers) {
        console.log(`  - ${user}`);
      }
      console.log(`\nMap users with: pnpm cli bedrock:users:map <iam-user> <email>`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('CredentialsProviderError')) {
      console.error('Error: AWS credentials not found');
      console.error('Configure credentials via:');
      console.error('  - AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY env vars');
      console.error('  - AWS shared config (~/.aws/credentials)');
      console.error('  - IAM instance role');
      return;
    }
    if (err instanceof Error && err.message.includes('LimitExceededException')) {
      console.error('Error: An export task is already running for this account');
      console.error('AWS allows only one active export task at a time.');
      console.error('Wait for it to complete or cancel it in the AWS Console.');
      return;
    }
    throw err;
  }
}
