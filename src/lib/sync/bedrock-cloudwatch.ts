import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import {
  CloudWatchLogsClient,
  CreateExportTaskCommand,
  DescribeExportTasksCommand,
  type ExportTaskStatusCode,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { type BedrockLogEntry } from './bedrock';
import { updateBedrockSyncState } from './bedrock';
import { parseBedrockExport } from './bedrock-export';
import { importBedrockLogEntries, type ImportResult } from './bedrock-import';

const gunzipAsync = promisify(gunzip);

// ============================================================================
// Types
// ============================================================================

export interface CloudWatchExportOptions {
  logGroupName: string;
  bucket: string;
  prefix: string;
  startTime: number;
  endTime: number;
}

export interface SyncOptions extends CloudWatchExportOptions {
  skipCleanup?: boolean;
  onProgress?: (message: string) => void;
  /** Override clients for testing */
  cwClient?: CloudWatchLogsClient;
  s3Client?: S3Client;
}

export interface BedrockCloudWatchSyncResult {
  taskId: string;
  filesProcessed: number;
  importResult: ImportResult;
}

export interface PollOptions {
  /** Initial delay between polls in ms (default: 5000) */
  initialDelayMs?: number;
  /** Maximum delay between polls in ms (default: 30000) */
  maxDelayMs?: number;
  /** Total timeout in ms (default: 600000 = 10 minutes) */
  timeoutMs?: number;
}

// ============================================================================
// CloudWatch Export
// ============================================================================

/**
 * Create a CloudWatch Logs export task to S3.
 *
 * @returns The export task ID
 */
export async function createCloudWatchExportTask(
  client: CloudWatchLogsClient,
  options: CloudWatchExportOptions
): Promise<string> {
  const { logGroupName, bucket, prefix, startTime, endTime } = options;

  const command = new CreateExportTaskCommand({
    logGroupName,
    from: startTime,
    to: endTime,
    destination: bucket,
    destinationPrefix: prefix,
  });

  const response = await client.send(command);

  if (!response.taskId) {
    throw new Error('CreateExportTask returned no taskId');
  }

  return response.taskId;
}

/**
 * Poll DescribeExportTasks until the task reaches a terminal state.
 *
 * Uses exponential backoff: 5s → 10s → 20s → 30s (capped).
 * Throws on FAILED, CANCELLED, or timeout.
 */
export async function waitForExportTaskCompletion(
  client: CloudWatchLogsClient,
  taskId: string,
  pollOptions?: PollOptions
): Promise<void> {
  const {
    initialDelayMs = 5_000,
    maxDelayMs = 30_000,
    timeoutMs = 600_000,
  } = pollOptions ?? {};

  const deadline = Date.now() + timeoutMs;
  let delay = initialDelayMs;

  while (Date.now() < deadline) {
    const command = new DescribeExportTasksCommand({ taskId });
    const response = await client.send(command);

    const task = response.exportTasks?.[0];
    if (!task) {
      throw new Error(`Export task ${taskId} not found`);
    }

    const status = task.status?.code as ExportTaskStatusCode | undefined;

    if (status === 'COMPLETED') {
      return;
    }

    if (status === 'FAILED' || status === 'CANCELLED') {
      throw new Error(`Export task ${taskId} ${status}: ${task.status?.message ?? 'unknown reason'}`);
    }

    // Wait with exponential backoff
    await sleep(Math.min(delay, deadline - Date.now()));
    delay = Math.min(delay * 2, maxDelayMs);
  }

  throw new Error(
    `Export task ${taskId} timed out after ${timeoutMs / 1000}s. ` +
    `Check task status in AWS Console.`
  );
}

// ============================================================================
// S3 Operations
// ============================================================================

/**
 * List all .gz files in the export prefix, handling pagination.
 * Skips the `aws-logs-write-test` marker file that AWS creates.
 */
export async function listExportedObjects(
  s3Client: S3Client,
  bucket: string,
  prefix: string
): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const command = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    });

    const response = await s3Client.send(command);

    for (const obj of response.Contents ?? []) {
      if (!obj.Key) continue;
      // Skip the write-test marker and non-.gz files
      if (obj.Key.includes('aws-logs-write-test')) continue;
      if (!obj.Key.endsWith('.gz')) continue;
      keys.push(obj.Key);
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return keys;
}

/**
 * Download a .gz file from S3 and decompress it.
 *
 * @returns The decompressed file content as a string
 */
export async function downloadAndDecompressObject(
  s3Client: S3Client,
  bucket: string,
  key: string
): Promise<string> {
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const response = await s3Client.send(command);

  if (!response.Body) {
    throw new Error(`S3 object ${key} has no body`);
  }

  const compressed = await response.Body.transformToByteArray();
  const decompressed = await gunzipAsync(Buffer.from(compressed));
  return decompressed.toString('utf-8');
}

/**
 * Delete exported objects from S3 after successful import.
 */
export async function deleteExportedObjects(
  s3Client: S3Client,
  bucket: string,
  keys: readonly string[]
): Promise<void> {
  if (keys.length === 0) return;

  // DeleteObjects supports max 1000 keys per request
  const batches: string[][] = [];
  for (let i = 0; i < keys.length; i += 1000) {
    batches.push(keys.slice(i, i + 1000));
  }

  for (const batch of batches) {
    const command = new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: {
        Objects: batch.map((key) => ({ Key: key })),
        Quiet: true,
      },
    });
    await s3Client.send(command);
  }
}

// ============================================================================
// CloudWatch S3 Export Parser
// ============================================================================

/**
 * Parse a CloudWatch S3 export file into BedrockLogEntry objects.
 *
 * CloudWatch CreateExportTask exports use the same ISO-timestamp format
 * as manual exports: `YYYY-MM-DDTHH:MM:SS.mmmZ {json}`.
 * Delegates to parseBedrockExport which handles multiline JSON correctly.
 */
export function parseCloudWatchS3Export(content: string): BedrockLogEntry[] {
  return parseBedrockExport(content);
}

// ============================================================================
// Orchestration
// ============================================================================

/**
 * Full automated sync: export CloudWatch logs to S3, download, parse, and import.
 *
 * Steps:
 * 1. Create CloudWatch export task
 * 2. Poll until completion
 * 3. List and download exported .gz files from S3
 * 4. Parse and import log entries
 * 5. Update sync state
 * 6. Clean up S3 objects (unless skipCleanup)
 */
export async function syncBedrockFromCloudWatch(
  options: SyncOptions
): Promise<BedrockCloudWatchSyncResult> {
  const {
    logGroupName,
    bucket,
    prefix,
    startTime,
    endTime,
    skipCleanup,
    onProgress,
    cwClient: cwClientOverride,
    s3Client: s3ClientOverride,
  } = options;

  const cwClient = cwClientOverride ?? new CloudWatchLogsClient({});
  const s3Client = s3ClientOverride ?? new S3Client({});

  // Step 1: Create export task
  onProgress?.('Creating CloudWatch export task...');
  const taskId = await createCloudWatchExportTask(cwClient, {
    logGroupName,
    bucket,
    prefix,
    startTime,
    endTime,
  });
  onProgress?.(`Export task created: ${taskId}`);

  // Step 2: Wait for completion
  onProgress?.('Waiting for export to complete...');
  await waitForExportTaskCompletion(cwClient, taskId);
  onProgress?.('Export completed.');

  // Step 3: List exported files
  const exportPrefix = `${prefix}/${taskId}`;
  const objectKeys = await listExportedObjects(s3Client, bucket, exportPrefix);
  onProgress?.(`Found ${objectKeys.length} exported file(s).`);

  // Step 4: Download, parse, and collect all entries
  const allEntries: BedrockLogEntry[] = [];
  let filesProcessed = 0;

  for (const key of objectKeys) {
    try {
      const content = await downloadAndDecompressObject(s3Client, bucket, key);
      const entries = parseCloudWatchS3Export(content);
      allEntries.push(...entries);
      filesProcessed++;
      onProgress?.(`  Processed ${key} (${entries.length} entries)`);
    } catch (err) {
      onProgress?.(`  Error processing ${key}: ${err}`);
    }
  }

  onProgress?.(`Total entries parsed: ${allEntries.length}`);

  // Step 5: Import
  onProgress?.('Importing records...');
  const importResult = await importBedrockLogEntries(allEntries);

  // Step 6: Update sync state
  if (importResult.imported > 0 || importResult.skipped > 0) {
    await updateBedrockSyncState(endTime);
  }

  // Step 7: Cleanup S3
  if (!skipCleanup && objectKeys.length > 0) {
    onProgress?.('Cleaning up S3 export files...');
    try {
      await deleteExportedObjects(s3Client, bucket, objectKeys);
      onProgress?.('S3 cleanup complete.');
    } catch (err) {
      onProgress?.(`Warning: S3 cleanup failed: ${err}`);
    }
  }

  return {
    taskId,
    filesProcessed,
    importResult,
  };
}

// ============================================================================
// Cron-specific helpers (two-phase approach)
// ============================================================================

/**
 * Check export task status without waiting.
 *
 * @returns The current status code, or null if the task is not found
 */
export async function checkExportTaskStatus(
  client: CloudWatchLogsClient,
  taskId: string
): Promise<{ status: string; message?: string } | null> {
  const command = new DescribeExportTasksCommand({ taskId });
  const response = await client.send(command);
  const task = response.exportTasks?.[0];
  if (!task) return null;
  return {
    status: task.status?.code ?? 'UNKNOWN',
    message: task.status?.message,
  };
}

// ============================================================================
// Utils
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
