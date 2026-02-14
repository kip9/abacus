import { NextResponse } from 'next/server';
import { wrapRouteHandlerWithSentry } from '@sentry/nextjs';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { S3Client } from '@aws-sdk/client-s3';
import {
  getBedrockSyncState,
  updateBedrockSyncState,
  checkExportTaskStatus,
  createCloudWatchExportTask,
} from '@/lib/sync';
import { getSyncState, updateSyncState } from '@/lib/sync';
import { listExportedObjects, downloadAndDecompressObject, deleteExportedObjects, parseCloudWatchS3Export } from '@/lib/sync/bedrock-cloudwatch';
import { importBedrockLogEntries } from '@/lib/sync/bedrock-import';

const SYNC_STATE_ID = 'bedrock-cron';
const DEFAULT_SYNC_DAYS = 7;
const MIN_SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Bedrock Cron Sync — Two-phase approach for CloudWatch log export.
 *
 * Phase 1 (no pending task): Create a CloudWatch export task, store taskId.
 * Phase 2 (pending task): Check export status. If complete, download + import.
 *
 * Designed to run hourly (0 * * * *).
 */
async function handler(request: Request) {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const logGroupName = process.env.AWS_BEDROCK_LOG_GROUP;
  const bucket = process.env.AWS_BEDROCK_EXPORT_BUCKET;
  const prefix = process.env.AWS_BEDROCK_EXPORT_PREFIX || 'abacus-export';

  if (!logGroupName || !bucket) {
    return NextResponse.json({
      success: true,
      service: 'bedrock',
      skipped: true,
      reason: 'AWS_BEDROCK_LOG_GROUP or AWS_BEDROCK_EXPORT_BUCKET not configured',
    });
  }

  const cwClient = new CloudWatchLogsClient({});
  const s3Client = new S3Client({});

  // Check for a pending export task
  const cronState = await getSyncState(SYNC_STATE_ID);
  const pendingTaskId = cronState.lastCursor;

  if (pendingTaskId) {
    // Phase 2: Check status of pending export task
    return handlePhase2(cwClient, s3Client, {
      taskId: pendingTaskId,
      bucket,
      prefix,
    });
  }

  // Phase 1: Determine if we should start a new export
  const { lastSyncedTimestamp } = await getBedrockSyncState();
  const now = Date.now();

  // Check minimum interval since last sync
  if (lastSyncedTimestamp && (now - lastSyncedTimestamp) < MIN_SYNC_INTERVAL_MS) {
    return NextResponse.json({
      success: true,
      service: 'bedrock',
      phase: 'skipped',
      reason: 'Recently synced, waiting for minimum interval',
      lastSynced: new Date(lastSyncedTimestamp).toISOString(),
    });
  }

  const startTime = lastSyncedTimestamp ?? now - DEFAULT_SYNC_DAYS * 24 * 60 * 60 * 1000;
  const endTime = now;

  try {
    const taskId = await createCloudWatchExportTask(cwClient, {
      logGroupName,
      bucket,
      prefix,
      startTime,
      endTime,
    });

    // Store task ID for phase 2
    await updateSyncState(SYNC_STATE_ID, new Date().toISOString(), taskId);

    return NextResponse.json({
      success: true,
      service: 'bedrock',
      phase: 'export-started',
      taskId,
      range: {
        from: new Date(startTime).toISOString(),
        to: new Date(endTime).toISOString(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({
      success: false,
      service: 'bedrock',
      phase: 'export-failed',
      error: message,
    }, { status: 500 });
  }
}

async function handlePhase2(
  cwClient: CloudWatchLogsClient,
  s3Client: S3Client,
  options: { taskId: string; bucket: string; prefix: string }
) {
  const { taskId, bucket, prefix } = options;

  const taskStatus = await checkExportTaskStatus(cwClient, taskId);

  if (!taskStatus) {
    // Task not found — clear state and let next invocation start fresh
    await updateSyncState(SYNC_STATE_ID, new Date().toISOString());
    return NextResponse.json({
      success: false,
      service: 'bedrock',
      phase: 'task-not-found',
      taskId,
    });
  }

  if (taskStatus.status === 'COMPLETED') {
    // Download and import
    const exportPrefix = `${prefix}/${taskId}`;
    const objectKeys = await listExportedObjects(s3Client, bucket, exportPrefix);

    const allEntries = [];
    let filesProcessed = 0;

    for (const key of objectKeys) {
      try {
        const content = await downloadAndDecompressObject(s3Client, bucket, key);
        const entries = parseCloudWatchS3Export(content);
        allEntries.push(...entries);
        filesProcessed++;
      } catch {
        // Continue processing remaining files
      }
    }

    const importResult = await importBedrockLogEntries(allEntries);

    // Update sync state
    if (importResult.imported > 0 || importResult.skipped > 0) {
      await updateBedrockSyncState(Date.now());
    }

    // Clean up S3
    if (objectKeys.length > 0) {
      try {
        await deleteExportedObjects(s3Client, bucket, objectKeys);
      } catch {
        // Non-fatal: import already succeeded
      }
    }

    // Clear pending task
    await updateSyncState(SYNC_STATE_ID, new Date().toISOString());

    return NextResponse.json({
      success: true,
      service: 'bedrock',
      phase: 'import-complete',
      taskId,
      filesProcessed,
      result: {
        imported: importResult.imported,
        skipped: importResult.skipped,
        unmapped: importResult.unmapped,
        errors: importResult.errors,
      },
    });
  }

  if (taskStatus.status === 'FAILED' || taskStatus.status === 'CANCELLED') {
    // Clear pending task — will retry on next invocation
    await updateSyncState(SYNC_STATE_ID, new Date().toISOString());
    return NextResponse.json({
      success: false,
      service: 'bedrock',
      phase: 'export-failed',
      taskId,
      status: taskStatus.status,
      message: taskStatus.message,
    });
  }

  // Still running (PENDING, RUNNING, etc.) — try again next invocation
  return NextResponse.json({
    success: true,
    service: 'bedrock',
    phase: 'export-pending',
    taskId,
    status: taskStatus.status,
  });
}

export const GET = wrapRouteHandlerWithSentry(handler, {
  method: 'GET',
  parameterizedRoute: '/api/cron/sync-bedrock',
});

export const POST = wrapRouteHandlerWithSentry(handler, {
  method: 'POST',
  parameterizedRoute: '/api/cron/sync-bedrock',
});
