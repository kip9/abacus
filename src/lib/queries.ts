import { db, sql, query, usageRecords, identityMappings, repositories, commits, commitAttributions } from './db';
import { eq, and, count, sql as drizzleSql } from 'drizzle-orm';
import { escapeLikePattern } from './utils';
import { getPreviousPeriodDates } from './comparison';


export interface UsageStats {
  totalTokens: number;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  activeUsers: number;
  claudeCodeTokens: number;
  cursorTokens: number;
  bedrockTokens: number;
  claudeCodeUsers: number;
  cursorUsers: number;
  bedrockUsers: number;
}

export interface UserSummary {
  email: string;
  totalTokens: number;
  totalCost: number;
  claudeCodeTokens: number;
  cursorTokens: number;
  bedrockTokens: number;
  favoriteModel: string;
  lastActive: string;
}

export interface ModelBreakdown {
  model: string;
  tokens: number;
  percentage: number;
  tool: string;
}

export interface DailyUsage {
  date: string;
  claudeCode: number;
  cursor: number;
  bedrock: number;
  cost: number;
  // Projection support fields (optional, added by applyProjections)
  isIncomplete?: boolean;
  projectedClaudeCode?: number;  // Original actual value before projection
  projectedCursor?: number;
  projectedBedrock?: number;
}

export interface DataCompleteness {
  claudeCode: { lastDataDate: string | null };
  cursor: { lastDataDate: string | null };
  bedrock: { lastDataDate: string | null };
}

export async function getOverallStats(startDate?: string, endDate?: string): Promise<UsageStats> {
  // Use extreme dates as defaults to avoid branching - query planner handles this efficiently
  const effectiveStartDate = startDate || '1970-01-01';
  const effectiveEndDate = endDate || '9999-12-31';

  const result = await db.execute<{
    totalTokens: number;
    totalCost: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    activeUsers: number;
    claudeCodeTokens: number;
    cursorTokens: number;
    bedrockTokens: number;
  }>(drizzleSql`
    SELECT
      COALESCE(SUM(input_tokens + cache_write_tokens + cache_read_tokens + output_tokens), 0)::bigint as "totalTokens",
      COALESCE(SUM(cost), 0)::float as "totalCost",
      COALESCE(SUM(input_tokens), 0)::bigint as "totalInputTokens",
      COALESCE(SUM(output_tokens), 0)::bigint as "totalOutputTokens",
      COALESCE(SUM(cache_read_tokens), 0)::bigint as "totalCacheReadTokens",
      COUNT(DISTINCT email)::int as "activeUsers",
      COALESCE(SUM(CASE WHEN tool = 'claude_code' THEN input_tokens + cache_write_tokens + cache_read_tokens + output_tokens ELSE 0 END), 0)::bigint as "claudeCodeTokens",
      COALESCE(SUM(CASE WHEN tool = 'cursor' THEN input_tokens + cache_write_tokens + cache_read_tokens + output_tokens ELSE 0 END), 0)::bigint as "cursorTokens",
      COALESCE(SUM(CASE WHEN tool = 'bedrock' THEN input_tokens + cache_write_tokens + cache_read_tokens + output_tokens ELSE 0 END), 0)::bigint as "bedrockTokens"
    FROM ${usageRecords}
    WHERE date >= ${effectiveStartDate} AND date <= ${effectiveEndDate}
  `);

  // User counts per tool need separate subqueries since COUNT DISTINCT with CASE doesn't work
  const userCountsResult = await db.execute<{ claudeCodeUsers: number; cursorUsers: number; bedrockUsers: number }>(drizzleSql`
    SELECT
      (SELECT COUNT(DISTINCT email) FROM ${usageRecords} WHERE tool = 'claude_code' AND date >= ${effectiveStartDate} AND date <= ${effectiveEndDate})::int as "claudeCodeUsers",
      (SELECT COUNT(DISTINCT email) FROM ${usageRecords} WHERE tool = 'cursor' AND date >= ${effectiveStartDate} AND date <= ${effectiveEndDate})::int as "cursorUsers",
      (SELECT COUNT(DISTINCT email) FROM ${usageRecords} WHERE tool = 'bedrock' AND date >= ${effectiveStartDate} AND date <= ${effectiveEndDate})::int as "bedrockUsers"
  `);

  return {
    ...result.rows[0],
    claudeCodeUsers: Number(userCountsResult.rows[0].claudeCodeUsers),
    cursorUsers: Number(userCountsResult.rows[0].cursorUsers),
    bedrockUsers: Number(userCountsResult.rows[0].bedrockUsers),
  } as UsageStats;
}

export interface UsageStatsWithComparison extends UsageStats {
  previousPeriod: {
    totalTokens: number;
    totalCost: number;
    activeUsers: number;
    claudeCodeTokens: number;
    cursorTokens: number;
    bedrockTokens: number;
    claudeCodeUsers: number;
    cursorUsers: number;
    bedrockUsers: number;
  };
}

export async function getOverallStatsWithComparison(
  startDate: string,
  endDate: string
): Promise<UsageStatsWithComparison> {
  const { prevStartDate, prevEndDate } = getPreviousPeriodDates(startDate, endDate);

  const result = await sql<{
    totalTokens: number;
    totalCost: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    claudeCodeTokens: number;
    cursorTokens: number;
    bedrockTokens: number;
    prevTotalTokens: number;
    prevTotalCost: number;
    prevClaudeCodeTokens: number;
    prevCursorTokens: number;
    prevBedrockTokens: number;
  }>`
    SELECT
      -- Current period
      COALESCE(SUM(CASE WHEN date >= ${startDate} AND date <= ${endDate}
        THEN input_tokens + cache_write_tokens + cache_read_tokens + output_tokens ELSE 0 END), 0)::bigint as "totalTokens",
      COALESCE(SUM(CASE WHEN date >= ${startDate} AND date <= ${endDate}
        THEN cost ELSE 0 END), 0)::float as "totalCost",
      COALESCE(SUM(CASE WHEN date >= ${startDate} AND date <= ${endDate}
        THEN input_tokens ELSE 0 END), 0)::bigint as "totalInputTokens",
      COALESCE(SUM(CASE WHEN date >= ${startDate} AND date <= ${endDate}
        THEN output_tokens ELSE 0 END), 0)::bigint as "totalOutputTokens",
      COALESCE(SUM(CASE WHEN date >= ${startDate} AND date <= ${endDate}
        THEN cache_read_tokens ELSE 0 END), 0)::bigint as "totalCacheReadTokens",
      COALESCE(SUM(CASE WHEN date >= ${startDate} AND date <= ${endDate} AND tool = 'claude_code'
        THEN input_tokens + cache_write_tokens + cache_read_tokens + output_tokens ELSE 0 END), 0)::bigint as "claudeCodeTokens",
      COALESCE(SUM(CASE WHEN date >= ${startDate} AND date <= ${endDate} AND tool = 'cursor'
        THEN input_tokens + cache_write_tokens + cache_read_tokens + output_tokens ELSE 0 END), 0)::bigint as "cursorTokens",
      COALESCE(SUM(CASE WHEN date >= ${startDate} AND date <= ${endDate} AND tool = 'bedrock'
        THEN input_tokens + cache_write_tokens + cache_read_tokens + output_tokens ELSE 0 END), 0)::bigint as "bedrockTokens",
      -- Previous period
      COALESCE(SUM(CASE WHEN date >= ${prevStartDate} AND date <= ${prevEndDate}
        THEN input_tokens + cache_write_tokens + cache_read_tokens + output_tokens ELSE 0 END), 0)::bigint as "prevTotalTokens",
      COALESCE(SUM(CASE WHEN date >= ${prevStartDate} AND date <= ${prevEndDate}
        THEN cost ELSE 0 END), 0)::float as "prevTotalCost",
      COALESCE(SUM(CASE WHEN date >= ${prevStartDate} AND date <= ${prevEndDate} AND tool = 'claude_code'
        THEN input_tokens + cache_write_tokens + cache_read_tokens + output_tokens ELSE 0 END), 0)::bigint as "prevClaudeCodeTokens",
      COALESCE(SUM(CASE WHEN date >= ${prevStartDate} AND date <= ${prevEndDate} AND tool = 'cursor'
        THEN input_tokens + cache_write_tokens + cache_read_tokens + output_tokens ELSE 0 END), 0)::bigint as "prevCursorTokens",
      COALESCE(SUM(CASE WHEN date >= ${prevStartDate} AND date <= ${prevEndDate} AND tool = 'bedrock'
        THEN input_tokens + cache_write_tokens + cache_read_tokens + output_tokens ELSE 0 END), 0)::bigint as "prevBedrockTokens"
    FROM usage_records
    WHERE date >= ${prevStartDate} AND date <= ${endDate}
  `;

  // User counts need separate subqueries since COUNT DISTINCT with CASE doesn't work as expected
  // COUNT(DISTINCT email) automatically excludes NULLs
  const userCountsResult = await sql<{
    activeUsers: number;
    prevActiveUsers: number;
    claudeCodeUsers: number;
    cursorUsers: number;
    bedrockUsers: number;
    prevClaudeCodeUsers: number;
    prevCursorUsers: number;
    prevBedrockUsers: number;
  }>`
    SELECT
      (SELECT COUNT(DISTINCT email) FROM usage_records WHERE date >= ${startDate} AND date <= ${endDate})::int as "activeUsers",
      (SELECT COUNT(DISTINCT email) FROM usage_records WHERE date >= ${prevStartDate} AND date <= ${prevEndDate})::int as "prevActiveUsers",
      (SELECT COUNT(DISTINCT email) FROM usage_records WHERE tool = 'claude_code' AND date >= ${startDate} AND date <= ${endDate})::int as "claudeCodeUsers",
      (SELECT COUNT(DISTINCT email) FROM usage_records WHERE tool = 'cursor' AND date >= ${startDate} AND date <= ${endDate})::int as "cursorUsers",
      (SELECT COUNT(DISTINCT email) FROM usage_records WHERE tool = 'bedrock' AND date >= ${startDate} AND date <= ${endDate})::int as "bedrockUsers",
      (SELECT COUNT(DISTINCT email) FROM usage_records WHERE tool = 'claude_code' AND date >= ${prevStartDate} AND date <= ${prevEndDate})::int as "prevClaudeCodeUsers",
      (SELECT COUNT(DISTINCT email) FROM usage_records WHERE tool = 'cursor' AND date >= ${prevStartDate} AND date <= ${prevEndDate})::int as "prevCursorUsers",
      (SELECT COUNT(DISTINCT email) FROM usage_records WHERE tool = 'bedrock' AND date >= ${prevStartDate} AND date <= ${prevEndDate})::int as "prevBedrockUsers"
  `;

  const row = result.rows[0];
  const userRow = userCountsResult.rows[0];

  return {
    totalTokens: Number(row.totalTokens),
    totalCost: Number(row.totalCost),
    totalInputTokens: Number(row.totalInputTokens),
    totalOutputTokens: Number(row.totalOutputTokens),
    totalCacheReadTokens: Number(row.totalCacheReadTokens),
    activeUsers: Number(userRow.activeUsers),
    claudeCodeTokens: Number(row.claudeCodeTokens),
    cursorTokens: Number(row.cursorTokens),
    bedrockTokens: Number(row.bedrockTokens),
    claudeCodeUsers: Number(userRow.claudeCodeUsers),
    cursorUsers: Number(userRow.cursorUsers),
    bedrockUsers: Number(userRow.bedrockUsers),
    previousPeriod: {
      totalTokens: Number(row.prevTotalTokens),
      totalCost: Number(row.prevTotalCost),
      activeUsers: Number(userRow.prevActiveUsers),
      claudeCodeTokens: Number(row.prevClaudeCodeTokens),
      cursorTokens: Number(row.prevCursorTokens),
      bedrockTokens: Number(row.prevBedrockTokens),
      claudeCodeUsers: Number(userRow.prevClaudeCodeUsers),
      cursorUsers: Number(userRow.prevCursorUsers),
      bedrockUsers: Number(userRow.prevBedrockUsers),
    },
  };
}

export interface UnattributedStats {
  totalTokens: number;
  totalCost: number;
}

/**
 * Get stats for records without email attribution.
 * Note: Since email is now required (NOT NULL) and both Claude Code and Cursor
 * provide email directly from their APIs, this will always return zeros.
 * Kept for API compatibility.
 */
export async function getUnattributedStats(): Promise<UnattributedStats> {
  const result = await db.execute<{ totalTokens: number; totalCost: number }>(drizzleSql`
    SELECT
      COALESCE(SUM(input_tokens + cache_write_tokens + cache_read_tokens + output_tokens), 0)::bigint as "totalTokens",
      COALESCE(SUM(cost), 0)::float as "totalCost"
    FROM ${usageRecords}
    WHERE email IS NULL
  `);
  return result.rows[0];
}

export async function getUserSummaries(
  limit = 50,
  offset = 0,
  search?: string,
  startDate?: string,
  endDate?: string
): Promise<UserSummary[]> {
  // Use extreme dates as defaults to avoid branching - query planner handles this efficiently
  const effectiveStartDate = startDate || '1970-01-01';
  const effectiveEndDate = endDate || '9999-12-31';
  const searchPattern = search ? `%${escapeLikePattern(search)}%` : null;

  // Single query with CTEs to avoid N+1 problem for favoriteModel
  const result = searchPattern
    ? await sql<UserSummary>`
        WITH user_stats AS (
          SELECT
            email,
            SUM(input_tokens + cache_write_tokens + cache_read_tokens + output_tokens)::bigint as "totalTokens",
            SUM(cost)::float as "totalCost",
            SUM(CASE WHEN tool = 'claude_code' THEN input_tokens + cache_write_tokens + cache_read_tokens + output_tokens ELSE 0 END)::bigint as "claudeCodeTokens",
            SUM(CASE WHEN tool = 'cursor' THEN input_tokens + cache_write_tokens + cache_read_tokens + output_tokens ELSE 0 END)::bigint as "cursorTokens",
            SUM(CASE WHEN tool = 'bedrock' THEN input_tokens + cache_write_tokens + cache_read_tokens + output_tokens ELSE 0 END)::bigint as "bedrockTokens",
            MAX(date)::text as "lastActive"
          FROM usage_records
          WHERE email LIKE ${searchPattern} AND email IS NOT NULL
            AND date >= ${effectiveStartDate} AND date <= ${effectiveEndDate}
          GROUP BY email
        ),
        user_models AS (
          SELECT DISTINCT ON (email)
            email,
            model as "favoriteModel"
          FROM (
            SELECT
              email,
              model,
              SUM(input_tokens + cache_write_tokens + cache_read_tokens + output_tokens) as model_tokens
            FROM usage_records
            WHERE email LIKE ${searchPattern} AND email IS NOT NULL
              AND date >= ${effectiveStartDate} AND date <= ${effectiveEndDate}
            GROUP BY email, model
          ) m
          ORDER BY email, model_tokens DESC
        )
        SELECT
          us.*,
          COALESCE(um."favoriteModel", 'unknown') as "favoriteModel"
        FROM user_stats us
        LEFT JOIN user_models um ON us.email = um.email
        ORDER BY us."totalTokens" DESC
        LIMIT ${limit} OFFSET ${offset}
      `
    : await sql<UserSummary>`
        WITH user_stats AS (
          SELECT
            email,
            SUM(input_tokens + cache_write_tokens + cache_read_tokens + output_tokens)::bigint as "totalTokens",
            SUM(cost)::float as "totalCost",
            SUM(CASE WHEN tool = 'claude_code' THEN input_tokens + cache_write_tokens + cache_read_tokens + output_tokens ELSE 0 END)::bigint as "claudeCodeTokens",
            SUM(CASE WHEN tool = 'cursor' THEN input_tokens + cache_write_tokens + cache_read_tokens + output_tokens ELSE 0 END)::bigint as "cursorTokens",
            SUM(CASE WHEN tool = 'bedrock' THEN input_tokens + cache_write_tokens + cache_read_tokens + output_tokens ELSE 0 END)::bigint as "bedrockTokens",
            MAX(date)::text as "lastActive"
          FROM usage_records
          WHERE email IS NOT NULL
            AND date >= ${effectiveStartDate} AND date <= ${effectiveEndDate}
          GROUP BY email
        ),
        user_models AS (
          SELECT DISTINCT ON (email)
            email,
            model as "favoriteModel"
          FROM (
            SELECT
              email,
              model,
              SUM(input_tokens + cache_write_tokens + cache_read_tokens + output_tokens) as model_tokens
            FROM usage_records
            WHERE email IS NOT NULL
              AND date >= ${effectiveStartDate} AND date <= ${effectiveEndDate}
            GROUP BY email, model
          ) m
          ORDER BY email, model_tokens DESC
        )
        SELECT
          us.*,
          COALESCE(um."favoriteModel", 'unknown') as "favoriteModel"
        FROM user_stats us
        LEFT JOIN user_models um ON us.email = um.email
        ORDER BY us."totalTokens" DESC
        LIMIT ${limit} OFFSET ${offset}
      `;

  return result.rows;
}

export async function getUserDetails(email: string) {

  const summaryResult = await sql<{
    email: string;
    totalTokens: number;
    totalCost: number;
    claudeCodeTokens: number;
    cursorTokens: number;
    bedrockTokens: number;
    lastActive: string;
    firstActive: string;
  }>`
    SELECT
      email,
      SUM(input_tokens + cache_write_tokens + cache_read_tokens + output_tokens)::bigint as "totalTokens",
      SUM(cost)::float as "totalCost",
      SUM(CASE WHEN tool = 'claude_code' THEN input_tokens + cache_write_tokens + cache_read_tokens + output_tokens ELSE 0 END)::bigint as "claudeCodeTokens",
      SUM(CASE WHEN tool = 'cursor' THEN input_tokens + cache_write_tokens + cache_read_tokens + output_tokens ELSE 0 END)::bigint as "cursorTokens",
      SUM(CASE WHEN tool = 'bedrock' THEN input_tokens + cache_write_tokens + cache_read_tokens + output_tokens ELSE 0 END)::bigint as "bedrockTokens",
      MAX(date)::text as "lastActive",
      MIN(date)::text as "firstActive"
    FROM usage_records
    WHERE email = ${email}
    GROUP BY email
  `;

  const modelResult = await sql<{ model: string; tokens: number; tool: string }>`
    SELECT
      model,
      SUM(input_tokens + cache_write_tokens + cache_read_tokens + output_tokens)::bigint as tokens,
      tool
    FROM usage_records
    WHERE email = ${email}
    GROUP BY model, tool
    ORDER BY tokens DESC
  `;

  const dailyResult = await sql<{ date: string; claudeCode: number; cursor: number; bedrock: number }>`
    SELECT
      date::text,
      SUM(CASE WHEN tool = 'claude_code' THEN input_tokens + cache_write_tokens + cache_read_tokens + output_tokens ELSE 0 END)::bigint as "claudeCode",
      SUM(CASE WHEN tool = 'cursor' THEN input_tokens + cache_write_tokens + cache_read_tokens + output_tokens ELSE 0 END)::bigint as cursor,
      SUM(CASE WHEN tool = 'bedrock' THEN input_tokens + cache_write_tokens + cache_read_tokens + output_tokens ELSE 0 END)::bigint as bedrock
    FROM usage_records
    WHERE email = ${email}
    GROUP BY date
    ORDER BY date DESC
    LIMIT 30
  `;

  return {
    summary: summaryResult.rows[0],
    modelBreakdown: modelResult.rows,
    dailyUsage: dailyResult.rows
  };
}

export interface UserDetailsExtended {
  summary: {
    email: string;
    totalTokens: number;
    totalCost: number;
    claudeCodeTokens: number;
    cursorTokens: number;
    bedrockTokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    lastActive: string;
    firstActive: string;
    daysActive: number;
  } | undefined;
  modelBreakdown: {
    model: string;
    tokens: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    tool: string;
  }[];
  dailyUsage: {
    date: string;
    claudeCode: number;
    cursor: number;
    bedrock: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
  }[];
}

export async function getUserDetailsExtended(
  email: string,
  startDate: string,
  endDate: string
): Promise<UserDetailsExtended> {
  const summaryResult = await sql<UserDetailsExtended['summary'] & Record<string, unknown>>`
    SELECT
      email,
      SUM(input_tokens + cache_write_tokens + cache_read_tokens + output_tokens)::bigint as "totalTokens",
      SUM(cost)::float as "totalCost",
      SUM(CASE WHEN tool = 'claude_code' THEN input_tokens + cache_write_tokens + cache_read_tokens + output_tokens ELSE 0 END)::bigint as "claudeCodeTokens",
      SUM(CASE WHEN tool = 'cursor' THEN input_tokens + cache_write_tokens + cache_read_tokens + output_tokens ELSE 0 END)::bigint as "cursorTokens",
      SUM(CASE WHEN tool = 'bedrock' THEN input_tokens + cache_write_tokens + cache_read_tokens + output_tokens ELSE 0 END)::bigint as "bedrockTokens",
      SUM(input_tokens)::bigint as "inputTokens",
      SUM(output_tokens)::bigint as "outputTokens",
      SUM(cache_read_tokens)::bigint as "cacheReadTokens",
      MAX(date)::text as "lastActive",
      MIN(date)::text as "firstActive",
      COUNT(DISTINCT date)::int as "daysActive"
    FROM usage_records
    WHERE email = ${email}
      AND date >= ${startDate} AND date <= ${endDate}
    GROUP BY email
  `;

  const modelResult = await sql<UserDetailsExtended['modelBreakdown'][number]>`
    SELECT
      model,
      SUM(input_tokens + cache_write_tokens + cache_read_tokens + output_tokens)::bigint as tokens,
      SUM(input_tokens)::bigint as "inputTokens",
      SUM(output_tokens)::bigint as "outputTokens",
      SUM(cost)::float as cost,
      tool
    FROM usage_records
    WHERE email = ${email}
      AND date >= ${startDate} AND date <= ${endDate}
    GROUP BY model, tool
    ORDER BY tokens DESC
  `;

  const dailyResult = await sql<UserDetailsExtended['dailyUsage'][number]>`
    WITH date_series AS (
      SELECT generate_series(
        ${startDate}::date,
        ${endDate}::date,
        '1 day'::interval
      )::date as date
    )
    SELECT
      ds.date::text,
      COALESCE(SUM(CASE WHEN r.tool = 'claude_code' THEN r.input_tokens + r.cache_write_tokens + r.cache_read_tokens + r.output_tokens ELSE 0 END), 0)::bigint as "claudeCode",
      COALESCE(SUM(CASE WHEN r.tool = 'cursor' THEN r.input_tokens + r.cache_write_tokens + r.cache_read_tokens + r.output_tokens ELSE 0 END), 0)::bigint as cursor,
      COALESCE(SUM(CASE WHEN r.tool = 'bedrock' THEN r.input_tokens + r.cache_write_tokens + r.cache_read_tokens + r.output_tokens ELSE 0 END), 0)::bigint as bedrock,
      COALESCE(SUM(r.input_tokens), 0)::bigint as "inputTokens",
      COALESCE(SUM(r.output_tokens), 0)::bigint as "outputTokens",
      COALESCE(SUM(r.cost), 0)::float as cost
    FROM date_series ds
    LEFT JOIN usage_records r ON r.date = ds.date AND r.email = ${email}
    GROUP BY ds.date
    ORDER BY ds.date ASC
  `;

  return {
    summary: summaryResult.rows[0],
    modelBreakdown: modelResult.rows,
    dailyUsage: dailyResult.rows
  };
}

export async function getModelBreakdown(startDate?: string, endDate?: string): Promise<ModelBreakdown[]> {
  // Note: We include all users (including unknown) in model breakdown
  // since we want to see total model usage across all API activity
  const effectiveStartDate = startDate || '1970-01-01';
  const effectiveEndDate = endDate || '9999-12-31';

  const result = await sql<{ model: string; tokens: number; tool: string }>`
    SELECT
      model,
      SUM(input_tokens + cache_write_tokens + cache_read_tokens + output_tokens)::bigint as tokens,
      tool
    FROM usage_records
    WHERE date >= ${effectiveStartDate} AND date <= ${effectiveEndDate}
    GROUP BY model, tool
    ORDER BY tokens DESC
    LIMIT 20
  `;

  const models = result.rows;
  const total = models.reduce((sum, m) => sum + Number(m.tokens), 0);

  return models.map(m => ({
    ...m,
    tokens: Number(m.tokens),
    percentage: total > 0 ? Math.round((Number(m.tokens) / total) * 100) : 0
  }));
}

export async function getDailyUsage(startDate: string, endDate: string): Promise<DailyUsage[]> {

  const result = await sql<DailyUsage>`
    WITH date_series AS (
      SELECT generate_series(
        ${startDate}::date,
        ${endDate}::date,
        '1 day'::interval
      )::date as date
    )
    SELECT
      ds.date::text,
      COALESCE(SUM(CASE WHEN r.tool = 'claude_code' THEN r.input_tokens + r.cache_write_tokens + r.cache_read_tokens + r.output_tokens ELSE 0 END), 0)::bigint as "claudeCode",
      COALESCE(SUM(CASE WHEN r.tool = 'cursor' THEN r.input_tokens + r.cache_write_tokens + r.cache_read_tokens + r.output_tokens ELSE 0 END), 0)::bigint as cursor,
      COALESCE(SUM(CASE WHEN r.tool = 'bedrock' THEN r.input_tokens + r.cache_write_tokens + r.cache_read_tokens + r.output_tokens ELSE 0 END), 0)::bigint as bedrock,
      COALESCE(SUM(r.cost), 0)::float as cost
    FROM date_series ds
    LEFT JOIN usage_records r ON r.date = ds.date
    GROUP BY ds.date
    ORDER BY ds.date ASC
  `;

  return result.rows;
}

/**
 * Get the last date with actual data for each tool.
 * Any date after the lastDataDate is considered incomplete (data may still be syncing).
 */
export async function getDataCompleteness(): Promise<DataCompleteness> {
  const result = await sql<{ claudeCodeLastDate: string | null; cursorLastDate: string | null; bedrockLastDate: string | null }>`
    SELECT
      MAX(CASE WHEN tool = 'claude_code' THEN date END)::text as "claudeCodeLastDate",
      MAX(CASE WHEN tool = 'cursor' THEN date END)::text as "cursorLastDate",
      MAX(CASE WHEN tool = 'bedrock' THEN date END)::text as "bedrockLastDate"
    FROM usage_records
  `;

  return {
    claudeCode: { lastDataDate: result.rows[0]?.claudeCodeLastDate || null },
    cursor: { lastDataDate: result.rows[0]?.cursorLastDate || null },
    bedrock: { lastDataDate: result.rows[0]?.bedrockLastDate || null },
  };
}

/**
 * Get tool records that have no email attribution.
 * Note: Since email is now required (NOT NULL) and both Claude Code and Cursor
 * provide email directly from their APIs, this will always return empty.
 * Kept for API compatibility.
 */
export async function getUnmappedToolRecords(tool: string = 'claude_code'): Promise<{ tool_record_id: string; usage_count: number }[]> {
  const result = await db.execute<{ tool_record_id: string; usage_count: number }>(drizzleSql`
    SELECT
      tool_record_id,
      COUNT(*)::int as usage_count
    FROM ${usageRecords}
    WHERE tool = ${tool}
      AND email IS NULL
      AND tool_record_id IS NOT NULL
    GROUP BY tool_record_id
    ORDER BY usage_count DESC
  `);

  return result.rows;
}

export async function getIdentityMappings(source?: string): Promise<{ source: string; external_id: string; email: string }[]> {
  const baseQuery = db
    .select({
      source: identityMappings.source,
      external_id: identityMappings.externalId,
      email: identityMappings.email,
    })
    .from(identityMappings);

  const result = source
    ? await baseQuery.where(eq(identityMappings.source, source))
    : await baseQuery;

  return result;
}

export async function setIdentityMapping(source: string, externalId: string, email: string): Promise<void> {
  await db
    .insert(identityMappings)
    .values({ source, externalId, email })
    .onConflictDoUpdate({
      target: [identityMappings.source, identityMappings.externalId],
      set: { email },
    });

  // Update existing records based on source type
  if (source === 'claude_code' || source === 'cursor') {
    // For API tools: update usage records
    await db
      .update(usageRecords)
      .set({ email })
      .where(and(
        eq(usageRecords.tool, source),
        eq(usageRecords.toolRecordId, externalId)
      ));
  } else {
    // For VCS providers (github, gitlab, etc.): update commit author emails
    await db.execute(drizzleSql`
      UPDATE ${commits} c
      SET author_email = ${email}
      FROM ${repositories} r
      WHERE c.repo_id = r.id
        AND r.source = ${source}
        AND c.author_id = ${externalId}
    `);
  }
}

export async function deleteIdentityMapping(source: string, externalId: string): Promise<void> {
  await db
    .delete(identityMappings)
    .where(and(
      eq(identityMappings.source, source),
      eq(identityMappings.externalId, externalId)
    ));
}

/**
 * Resolve a username or email to a full email address.
 * If input contains @, returns as-is. Otherwise looks up username@%.
 */
export async function resolveUserEmail(usernameOrEmail: string): Promise<string | null> {
  // If it already looks like an email, return as-is
  if (usernameOrEmail.includes('@')) {
    return usernameOrEmail;
  }

  // Look up by username prefix (escape to prevent LIKE injection)
  const result = await db.execute<{ email: string }>(drizzleSql`
    SELECT DISTINCT email FROM ${usageRecords}
    WHERE email LIKE ${escapeLikePattern(usernameOrEmail) + '@%'}
    LIMIT 1
  `);

  return result.rows[0]?.email || null;
}

export async function getKnownEmails(): Promise<string[]> {
  const result = await db.execute<{ email: string }>(drizzleSql`
    SELECT DISTINCT email FROM (
      SELECT email FROM ${usageRecords} WHERE tool = 'cursor' AND email IS NOT NULL
      UNION
      SELECT email FROM ${identityMappings}
      UNION
      SELECT email FROM ${usageRecords} WHERE email LIKE '%@%' AND email IS NOT NULL
    ) AS combined
    ORDER BY email ASC
  `);

  return result.rows.map(r => r.email);
}


export interface UserPivotData {
  email: string;
  totalTokens: number;
  totalCost: number;
  claudeCodeTokens: number;
  cursorTokens: number;
  bedrockTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  firstActive: string;
  lastActive: string;
  daysActive: number;
  avgTokensPerDay: number;
  toolCount: number;
  hasThinkingModels: boolean;
  daysSinceLastActive: number;
}

export interface UserPivotResult {
  users: UserPivotData[];
  totalCount: number;
}

export async function getAllUsersPivot(
  sortBy: string = 'totalTokens',
  sortDir: 'asc' | 'desc' = 'desc',
  search?: string,
  startDate?: string,
  endDate?: string,
  limit: number = 500,
  offset: number = 0
): Promise<UserPivotResult> {
  // Use extreme dates as defaults to avoid branching - query planner handles this efficiently
  const effectiveStartDate = startDate || '1970-01-01';
  const effectiveEndDate = endDate || '9999-12-31';

  const validSortColumns = [
    'email', 'totalTokens', 'totalCost', 'claudeCodeTokens', 'cursorTokens',
    'bedrockTokens', 'inputTokens', 'outputTokens', 'firstActive', 'lastActive',
    'daysActive', 'avgTokensPerDay'
  ];
  const safeSortBy = validSortColumns.includes(sortBy) ? sortBy : 'totalTokens';
  const searchPattern = search ? `%${escapeLikePattern(search)}%` : null;

  // Get stats for specified date range, but lastActive from all time
  type UserPivotQueryRow = Omit<UserPivotData, 'avgTokensPerDay' | 'daysSinceLastActive'>;
  const result = searchPattern
    ? await sql<UserPivotQueryRow>`
        SELECT
          r.email,
          SUM(r.input_tokens + r.cache_write_tokens + r.cache_read_tokens + r.output_tokens)::bigint as "totalTokens",
          SUM(r.cost)::float as "totalCost",
          SUM(CASE WHEN r.tool = 'claude_code' THEN r.input_tokens + r.cache_write_tokens + r.cache_read_tokens + r.output_tokens ELSE 0 END)::bigint as "claudeCodeTokens",
          SUM(CASE WHEN r.tool = 'cursor' THEN r.input_tokens + r.cache_write_tokens + r.cache_read_tokens + r.output_tokens ELSE 0 END)::bigint as "cursorTokens",
          SUM(CASE WHEN r.tool = 'bedrock' THEN r.input_tokens + r.cache_write_tokens + r.cache_read_tokens + r.output_tokens ELSE 0 END)::bigint as "bedrockTokens",
          SUM(r.input_tokens)::bigint as "inputTokens",
          SUM(r.output_tokens)::bigint as "outputTokens",
          SUM(r.cache_read_tokens)::bigint as "cacheReadTokens",
          MIN(r.date)::text as "firstActive",
          la."lastActive",
          COUNT(DISTINCT r.date)::int as "daysActive",
          COUNT(DISTINCT r.tool)::int as "toolCount",
          BOOL_OR(r.raw_model LIKE '% (T)' OR r.raw_model LIKE '% (HT)' OR r.raw_model LIKE '%-thinking' OR r.raw_model LIKE '%-high-thinking')::boolean as "hasThinkingModels"
        FROM usage_records r
        JOIN (
          SELECT email, MAX(date)::text as "lastActive"
          FROM usage_records
          WHERE email IS NOT NULL
          GROUP BY email
        ) la ON r.email = la.email
        WHERE r.email IS NOT NULL
          AND r.email LIKE ${searchPattern}
          AND r.date >= ${effectiveStartDate} AND r.date <= ${effectiveEndDate}
        GROUP BY r.email, la."lastActive"
        ORDER BY "totalTokens" DESC
      `
    : await sql<UserPivotQueryRow>`
        SELECT
          r.email,
          SUM(r.input_tokens + r.cache_write_tokens + r.cache_read_tokens + r.output_tokens)::bigint as "totalTokens",
          SUM(r.cost)::float as "totalCost",
          SUM(CASE WHEN r.tool = 'claude_code' THEN r.input_tokens + r.cache_write_tokens + r.cache_read_tokens + r.output_tokens ELSE 0 END)::bigint as "claudeCodeTokens",
          SUM(CASE WHEN r.tool = 'cursor' THEN r.input_tokens + r.cache_write_tokens + r.cache_read_tokens + r.output_tokens ELSE 0 END)::bigint as "cursorTokens",
          SUM(CASE WHEN r.tool = 'bedrock' THEN r.input_tokens + r.cache_write_tokens + r.cache_read_tokens + r.output_tokens ELSE 0 END)::bigint as "bedrockTokens",
          SUM(r.input_tokens)::bigint as "inputTokens",
          SUM(r.output_tokens)::bigint as "outputTokens",
          SUM(r.cache_read_tokens)::bigint as "cacheReadTokens",
          MIN(r.date)::text as "firstActive",
          la."lastActive",
          COUNT(DISTINCT r.date)::int as "daysActive",
          COUNT(DISTINCT r.tool)::int as "toolCount",
          BOOL_OR(r.raw_model LIKE '% (T)' OR r.raw_model LIKE '% (HT)' OR r.raw_model LIKE '%-thinking' OR r.raw_model LIKE '%-high-thinking')::boolean as "hasThinkingModels"
        FROM usage_records r
        JOIN (
          SELECT email, MAX(date)::text as "lastActive"
          FROM usage_records
          WHERE email IS NOT NULL
          GROUP BY email
        ) la ON r.email = la.email
        WHERE r.email IS NOT NULL
          AND r.date >= ${effectiveStartDate} AND r.date <= ${effectiveEndDate}
        GROUP BY r.email, la."lastActive"
        ORDER BY "totalTokens" DESC
      `;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let users = result.rows.map(u => {
    // Calculate days since last active
    const lastActiveDate = new Date(u.lastActive);
    lastActiveDate.setHours(0, 0, 0, 0);
    const daysSinceLastActive = Math.floor((today.getTime() - lastActiveDate.getTime()) / (1000 * 60 * 60 * 24));

    return {
      ...u,
      avgTokensPerDay: u.daysActive > 0 ? Math.round(Number(u.totalTokens) / u.daysActive) : 0,
      daysSinceLastActive,
    };
  }) as UserPivotData[];

  // Apply sorting in JS since we can't do dynamic ORDER BY
  // Note: bigint columns come back as strings from postgres, so we need to handle
  // numeric string comparison properly
  const stringColumns = new Set(['email', 'firstActive', 'lastActive']);
  if (safeSortBy !== 'totalTokens' || sortDir !== 'desc') {
    users = users.sort((a, b) => {
      const aVal = a[safeSortBy as keyof UserPivotData];
      const bVal = b[safeSortBy as keyof UserPivotData];
      if (stringColumns.has(safeSortBy)) {
        return sortDir === 'asc'
          ? String(aVal).localeCompare(String(bVal))
          : String(bVal).localeCompare(String(aVal));
      }
      // Numeric comparison (handles bigint strings from postgres)
      return sortDir === 'asc'
        ? Number(aVal) - Number(bVal)
        : Number(bVal) - Number(aVal);
    });
  }

  // Apply pagination after sorting
  const totalCount = users.length;
  const paginatedUsers = users.slice(offset, offset + limit);

  return { users: paginatedUsers, totalCount };
}

// Insert usage record
// - Cursor: each event has unique timestampMs, conflicts only happen for true duplicates
// - Anthropic: timestampMs is null, re-syncs may have updated totals so we DO UPDATE SET
// Note: DO UPDATE SET is correct for both - Cursor conflicts are rare, Anthropic needs updates
export async function insertUsageRecord(record: {
  date: string;
  email: string;
  tool: string;
  model: string;
  rawModel?: string;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  cost: number;
  toolRecordId?: string;
  timestampMs?: number;  // Epoch milliseconds for per-event deduplication (Cursor)
}): Promise<void> {
  await db.execute(drizzleSql`
    INSERT INTO ${usageRecords} (date, email, tool, model, raw_model, input_tokens, cache_write_tokens, cache_read_tokens, output_tokens, cost, tool_record_id, timestamp_ms)
    VALUES (${record.date}, ${record.email}, ${record.tool}, ${record.model}, ${record.rawModel ?? null}, ${record.inputTokens}, ${record.cacheWriteTokens}, ${record.cacheReadTokens}, ${record.outputTokens}, ${record.cost}, ${record.toolRecordId ?? null}, ${record.timestampMs ?? null})
    ON CONFLICT (date, COALESCE(email, ''), tool, COALESCE(raw_model, ''), COALESCE(tool_record_id, ''), COALESCE(timestamp_ms::text, ''))
    DO UPDATE SET
      model = EXCLUDED.model,
      input_tokens = EXCLUDED.input_tokens,
      cache_write_tokens = EXCLUDED.cache_write_tokens,
      cache_read_tokens = EXCLUDED.cache_read_tokens,
      output_tokens = EXCLUDED.output_tokens,
      cost = EXCLUDED.cost
  `);
}

// Get existing mapping for an identity
export async function getIdentityMapping(source: string, externalId: string): Promise<string | null> {
  const result = await db
    .select({ email: identityMappings.email })
    .from(identityMappings)
    .where(and(
      eq(identityMappings.source, source),
      eq(identityMappings.externalId, externalId)
    ));
  return result[0]?.email || null;
}

export interface LifetimeStats {
  totalTokens: number;
  totalCost: number;
  totalUsers: number;
  firstRecordDate: string | null;
  totalCommits: number;
  aiAttributedCommits: number;
  totalRepos: number;
}

export async function getLifetimeStats(): Promise<LifetimeStats> {
  const [usageResult, commitsResult, reposResult] = await Promise.all([
    sql<{ totalTokens: number; totalCost: number; totalUsers: number; firstRecordDate: string | null }>`
      SELECT
        COALESCE(SUM(input_tokens + cache_write_tokens + cache_read_tokens + output_tokens), 0)::bigint as "totalTokens",
        COALESCE(SUM(cost), 0)::float as "totalCost",
        COUNT(DISTINCT email)::int as "totalUsers",
        MIN(date)::text as "firstRecordDate"
      FROM usage_records
    `,
    sql<{ totalCommits: number; aiAttributedCommits: number }>`
      SELECT
        COUNT(*)::int as "totalCommits",
        COUNT(*) FILTER (WHERE ai_tool IS NOT NULL)::int as "aiAttributedCommits"
      FROM commits
    `,
    sql<{ totalRepos: number }>`
      SELECT COUNT(*)::int as "totalRepos" FROM repositories
    `,
  ]);

  return {
    ...usageResult.rows[0],
    totalCommits: commitsResult.rows[0]?.totalCommits || 0,
    aiAttributedCommits: commitsResult.rows[0]?.aiAttributedCommits || 0,
    totalRepos: reposResult.rows[0]?.totalRepos || 0,
  } as LifetimeStats;
}

export interface UserLifetimeStats {
  totalTokens: number;
  totalCost: number;
  firstRecordDate: string | null;
  favoriteTool: string | null;
  recordDay: { date: string; tokens: number } | null;
}

export async function getUserLifetimeStats(email: string): Promise<UserLifetimeStats> {
  const [statsResult, toolResult, recordDayResult] = await Promise.all([
    sql<{ totalTokens: number; totalCost: number; firstRecordDate: string | null }>`
      SELECT
        COALESCE(SUM(input_tokens + cache_write_tokens + cache_read_tokens + output_tokens), 0)::bigint as "totalTokens",
        COALESCE(SUM(cost), 0)::float as "totalCost",
        MIN(date)::text as "firstRecordDate"
      FROM usage_records
      WHERE email = ${email}
    `,
    sql<{ tool: string; tokens: number }>`
      SELECT tool, SUM(input_tokens + cache_write_tokens + cache_read_tokens + output_tokens)::bigint as tokens
      FROM usage_records
      WHERE email = ${email}
      GROUP BY tool
      ORDER BY tokens DESC
      LIMIT 1
    `,
    sql<{ date: string; tokens: number }>`
      SELECT date::text, SUM(input_tokens + cache_write_tokens + cache_read_tokens + output_tokens)::bigint as tokens
      FROM usage_records
      WHERE email = ${email}
      GROUP BY date
      ORDER BY tokens DESC
      LIMIT 1
    `
  ]);

  return {
    ...statsResult.rows[0],
    favoriteTool: toolResult.rows[0]?.tool || null,
    recordDay: recordDayResult.rows[0] ? {
      date: recordDayResult.rows[0].date,
      tokens: Number(recordDayResult.rows[0].tokens)
    } : null
  } as UserLifetimeStats;
}

// ============================================================================
// Commit Stats (VCS-agnostic)
// ============================================================================

export interface CommitStats {
  totalCommits: number;
  aiAssistedCommits: number;
  aiAssistanceRate: number;
  totalAdditions: number;
  totalDeletions: number;
  aiAdditions: number;
  aiDeletions: number;
  toolBreakdown: {
    tool: string;
    commits: number;
    additions: number;
    deletions: number;
  }[];
  repositoryCount: number;
}

export async function getCommitStats(startDate?: string, endDate?: string): Promise<CommitStats> {
  // Use extreme dates as defaults - query planner handles this efficiently
  const effectiveStartDate = startDate || '1970-01-01';
  const effectiveEndDate = endDate || '9999-12-31';

  const [overallResult, toolBreakdownResult, repoCountResult] = await Promise.all([
    sql<{
      totalCommits: number;
      aiAssistedCommits: number;
      totalAdditions: number;
      totalDeletions: number;
      aiAdditions: number;
      aiDeletions: number;
    }>`
      SELECT
        COUNT(*)::int as "totalCommits",
        COUNT(*) FILTER (WHERE ai_tool IS NOT NULL)::int as "aiAssistedCommits",
        COALESCE(SUM(additions), 0)::int as "totalAdditions",
        COALESCE(SUM(deletions), 0)::int as "totalDeletions",
        COALESCE(SUM(additions) FILTER (WHERE ai_tool IS NOT NULL), 0)::int as "aiAdditions",
        COALESCE(SUM(deletions) FILTER (WHERE ai_tool IS NOT NULL), 0)::int as "aiDeletions"
      FROM commits
      WHERE committed_at >= ${effectiveStartDate}::timestamp
        AND committed_at < (${effectiveEndDate}::date + interval '1 day')
    `,
    sql<{ tool: string; commits: number; additions: number; deletions: number }>`
      SELECT
        ai_tool as tool,
        COUNT(*)::int as commits,
        COALESCE(SUM(additions), 0)::int as additions,
        COALESCE(SUM(deletions), 0)::int as deletions
      FROM commits
      WHERE ai_tool IS NOT NULL
        AND committed_at >= ${effectiveStartDate}::timestamp
        AND committed_at < (${effectiveEndDate}::date + interval '1 day')
      GROUP BY ai_tool
      ORDER BY commits DESC
    `,
    sql<{ count: number }>`
      SELECT COUNT(DISTINCT repo_id)::int as count
      FROM commits
      WHERE committed_at >= ${effectiveStartDate}::timestamp
        AND committed_at < (${effectiveEndDate}::date + interval '1 day')
    `
  ]);

  const overall = overallResult.rows[0];
  const totalCommits = Number(overall.totalCommits);
  const aiAssistedCommits = Number(overall.aiAssistedCommits);

  return {
    totalCommits,
    aiAssistedCommits,
    aiAssistanceRate: totalCommits > 0 ? Math.round((aiAssistedCommits / totalCommits) * 100) : 0,
    totalAdditions: Number(overall.totalAdditions),
    totalDeletions: Number(overall.totalDeletions),
    aiAdditions: Number(overall.aiAdditions),
    aiDeletions: Number(overall.aiDeletions),
    toolBreakdown: toolBreakdownResult.rows.map(row => ({
      tool: row.tool,
      commits: Number(row.commits),
      additions: Number(row.additions),
      deletions: Number(row.deletions),
    })),
    repositoryCount: Number(repoCountResult.rows[0].count),
  };
}

export interface CommitStatsWithComparison extends CommitStats {
  previousPeriod?: {
    totalCommits: number;
    aiAssistedCommits: number;
    aiAssistanceRate: number;
    repositoryCount: number;
  };
}

export async function getCommitStatsWithComparison(
  startDate: string,
  endDate: string
): Promise<CommitStatsWithComparison> {
  const { prevStartDate, prevEndDate } = getPreviousPeriodDates(startDate, endDate);

  const [currentStats, prevResult] = await Promise.all([
    getCommitStats(startDate, endDate),
    sql<{ totalCommits: number; aiAssistedCommits: number; repositoryCount: number }>`
      SELECT
        COUNT(*)::int as "totalCommits",
        COUNT(*) FILTER (WHERE ai_tool IS NOT NULL)::int as "aiAssistedCommits",
        COUNT(DISTINCT repo_id)::int as "repositoryCount"
      FROM commits
      WHERE committed_at >= ${prevStartDate}::timestamp
        AND committed_at < (${prevEndDate}::date + interval '1 day')
    `
  ]);

  const prev = prevResult.rows[0];
  const prevTotalCommits = Number(prev.totalCommits);
  const prevAiAssistedCommits = Number(prev.aiAssistedCommits);

  return {
    ...currentStats,
    previousPeriod: {
      totalCommits: prevTotalCommits,
      aiAssistedCommits: prevAiAssistedCommits,
      aiAssistanceRate: prevTotalCommits > 0 ? Math.round((prevAiAssistedCommits / prevTotalCommits) * 100) : 0,
      repositoryCount: Number(prev.repositoryCount),
    },
  };
}

// ============================================================================
// Repository Stats (per-repo commit breakdown)
// ============================================================================

export interface RepositoryPivotData {
  id: number;
  source: string;
  fullName: string;
  totalCommits: number;
  aiAssistedCommits: number;
  aiAssistanceRate: number;
  totalAdditions: number;
  totalDeletions: number;
  aiAdditions: number;
  aiDeletions: number;
  uniqueAuthors: number;
  firstCommit: string | null;
  lastCommit: string | null;
  claudeCodeCommits: number;
  cursorCommits: number;
  copilotCommits: number;
}

export interface RepositoryPivotResult {
  repositories: RepositoryPivotData[];
  totalCount: number;
}

export async function getRepositoryPivot(
  sortBy: string = 'totalCommits',
  sortDir: 'asc' | 'desc' = 'desc',
  search?: string,
  startDate?: string,
  endDate?: string,
  limit: number = 500,
  offset: number = 0
): Promise<RepositoryPivotResult> {
  const effectiveStartDate = startDate || '1970-01-01';
  const effectiveEndDate = endDate || '9999-12-31';

  const validSortColumns = [
    'fullName', 'totalCommits', 'aiAssistedCommits', 'aiAssistanceRate',
    'totalAdditions', 'totalDeletions', 'uniqueAuthors', 'lastCommit'
  ];
  const safeSortBy = validSortColumns.includes(sortBy) ? sortBy : 'totalCommits';
  const searchPattern = search ? `%${escapeLikePattern(search)}%` : null;

  type RepositoryPivotQueryRow = Omit<RepositoryPivotData, 'aiAssistanceRate'>;
  const result = searchPattern
    ? await sql<RepositoryPivotQueryRow>`
        SELECT
          r.id,
          r.source,
          r.full_name as "fullName",
          COUNT(c.id)::int as "totalCommits",
          COUNT(c.id) FILTER (WHERE c.ai_tool IS NOT NULL)::int as "aiAssistedCommits",
          COALESCE(SUM(c.additions), 0)::int as "totalAdditions",
          COALESCE(SUM(c.deletions), 0)::int as "totalDeletions",
          COALESCE(SUM(c.additions) FILTER (WHERE c.ai_tool IS NOT NULL), 0)::int as "aiAdditions",
          COALESCE(SUM(c.deletions) FILTER (WHERE c.ai_tool IS NOT NULL), 0)::int as "aiDeletions",
          COUNT(DISTINCT c.author_email)::int as "uniqueAuthors",
          MIN(c.committed_at)::text as "firstCommit",
          MAX(c.committed_at)::text as "lastCommit",
          COUNT(c.id) FILTER (WHERE c.ai_tool = 'claude_code')::int as "claudeCodeCommits",
          COUNT(c.id) FILTER (WHERE c.ai_tool = 'cursor')::int as "cursorCommits",
          COUNT(c.id) FILTER (WHERE c.ai_tool = 'github_copilot')::int as "copilotCommits"
        FROM repositories r
        LEFT JOIN commits c ON c.repo_id = r.id
          AND c.committed_at >= ${effectiveStartDate}::timestamp
          AND c.committed_at < (${effectiveEndDate}::date + interval '1 day')
        WHERE r.full_name ILIKE ${searchPattern}
        GROUP BY r.id, r.source, r.full_name
        HAVING COUNT(c.id) > 0
        ORDER BY "totalCommits" DESC
      `
    : await sql<RepositoryPivotQueryRow>`
        SELECT
          r.id,
          r.source,
          r.full_name as "fullName",
          COUNT(c.id)::int as "totalCommits",
          COUNT(c.id) FILTER (WHERE c.ai_tool IS NOT NULL)::int as "aiAssistedCommits",
          COALESCE(SUM(c.additions), 0)::int as "totalAdditions",
          COALESCE(SUM(c.deletions), 0)::int as "totalDeletions",
          COALESCE(SUM(c.additions) FILTER (WHERE c.ai_tool IS NOT NULL), 0)::int as "aiAdditions",
          COALESCE(SUM(c.deletions) FILTER (WHERE c.ai_tool IS NOT NULL), 0)::int as "aiDeletions",
          COUNT(DISTINCT c.author_email)::int as "uniqueAuthors",
          MIN(c.committed_at)::text as "firstCommit",
          MAX(c.committed_at)::text as "lastCommit",
          COUNT(c.id) FILTER (WHERE c.ai_tool = 'claude_code')::int as "claudeCodeCommits",
          COUNT(c.id) FILTER (WHERE c.ai_tool = 'cursor')::int as "cursorCommits",
          COUNT(c.id) FILTER (WHERE c.ai_tool = 'github_copilot')::int as "copilotCommits"
        FROM repositories r
        LEFT JOIN commits c ON c.repo_id = r.id
          AND c.committed_at >= ${effectiveStartDate}::timestamp
          AND c.committed_at < (${effectiveEndDate}::date + interval '1 day')
        GROUP BY r.id, r.source, r.full_name
        HAVING COUNT(c.id) > 0
        ORDER BY "totalCommits" DESC
      `;

  // Calculate AI assistance rate and sort in JS (for dynamic sorting)
  let repositories = result.rows.map(row => ({
    ...row,
    aiAssistanceRate: row.totalCommits > 0
      ? Math.round((row.aiAssistedCommits / row.totalCommits) * 100)
      : 0,
  })) as RepositoryPivotData[];

  // Apply custom sorting if needed
  const stringColumns = new Set(['fullName', 'source', 'firstCommit', 'lastCommit']);
  if (safeSortBy !== 'totalCommits' || sortDir !== 'desc') {
    repositories = repositories.sort((a, b) => {
      const aVal = a[safeSortBy as keyof RepositoryPivotData];
      const bVal = b[safeSortBy as keyof RepositoryPivotData];
      if (stringColumns.has(safeSortBy)) {
        return sortDir === 'asc'
          ? String(aVal ?? '').localeCompare(String(bVal ?? ''))
          : String(bVal ?? '').localeCompare(String(aVal ?? ''));
      }
      return sortDir === 'asc'
        ? Number(aVal) - Number(bVal)
        : Number(bVal) - Number(aVal);
    });
  }

  const totalCount = repositories.length;
  const paginatedRepos = repositories.slice(offset, offset + limit);

  return { repositories: paginatedRepos, totalCount };
}

/**
 * Get daily commit trends for charts
 */
export interface DailyCommitStats {
  date: string;
  totalCommits: number;
  aiAssistedCommits: number;
  additions: number;
  deletions: number;
}

export async function getDailyCommitStats(
  startDate: string,
  endDate: string
): Promise<DailyCommitStats[]> {
  const result = await sql<DailyCommitStats>`
    WITH date_series AS (
      SELECT generate_series(
        ${startDate}::date,
        ${endDate}::date,
        '1 day'::interval
      )::date as date
    )
    SELECT
      ds.date::text,
      COALESCE(COUNT(c.id), 0)::int as "totalCommits",
      COALESCE(COUNT(c.id) FILTER (WHERE c.ai_tool IS NOT NULL), 0)::int as "aiAssistedCommits",
      COALESCE(SUM(c.additions), 0)::int as additions,
      COALESCE(SUM(c.deletions), 0)::int as deletions
    FROM date_series ds
    LEFT JOIN commits c ON c.committed_at::date = ds.date
    GROUP BY ds.date
    ORDER BY ds.date ASC
  `;

  return result.rows;
}

/**
 * Get a user's percentile rank based on avgTokensPerDay compared to all users
 * Returns a number 0-100 where higher = better (e.g., 85 means top 15%)
 */
export async function getUserPercentile(
  email: string,
  startDate: string,
  endDate: string
): Promise<number> {
  // Get all users' avgTokensPerDay for the period
  const result = await sql<{ email: string; avg_tokens_per_day: number }>`
    SELECT
      email,
      CASE
        WHEN COUNT(DISTINCT date) > 0
        THEN SUM(input_tokens + cache_write_tokens + cache_read_tokens + output_tokens)::float / COUNT(DISTINCT date)
        ELSE 0
      END as avg_tokens_per_day
    FROM usage_records
    WHERE email IS NOT NULL
      AND date >= ${startDate} AND date <= ${endDate}
    GROUP BY email
    HAVING COUNT(DISTINCT date) >= 2
    ORDER BY avg_tokens_per_day DESC
  `;

  const users = result.rows;
  const totalUsers = users.length;

  if (totalUsers === 0) {
    return 50; // Default to middle if no data
  }

  // Find the user's position
  const userIndex = users.findIndex(u => u.email === email);

  if (userIndex === -1) {
    return 0; // User not found or doesn't meet min days threshold
  }

  // Handle single user case - they are the top (and only) user
  if (totalUsers === 1) {
    return 100;
  }

  // Calculate percentile (0 = worst, 100 = best)
  // Position 0 (best) = 100th percentile
  // Position last = 0th percentile
  const percentile = Math.round(((totalUsers - 1 - userIndex) / (totalUsers - 1)) * 100);

  return Math.max(0, Math.min(100, percentile));
}

/**
 * Repository Detail Queries
 */

export interface RepositoryDetails {
  id: number;
  source: string;
  fullName: string;
  totalCommits: number;
  aiAssistedCommits: number;
  aiAssistanceRate: number;
  totalAdditions: number;
  totalDeletions: number;
  aiAdditions: number;
  aiDeletions: number;
  uniqueAuthors: number;
  firstCommit: string | null;
  lastCommit: string | null;
  claudeCodeCommits: number;
  cursorCommits: number;
  copilotCommits: number;
  windsurfCommits: number;
}

export interface CommitAttributionData {
  aiTool: string;
  aiModel: string | null;
  confidence: string;
  source: string | null;
}

export interface RepositoryCommit {
  id: number;
  commitId: string;
  authorEmail: string;
  mappedEmail: string | null;
  committedAt: string;
  message: string | null;
  aiTool: string | null;
  aiModel: string | null;
  additions: number;
  deletions: number;
  attributions?: CommitAttributionData[];
}

export interface RepositoryAuthor {
  authorEmail: string;
  totalCommits: number;
  aiAssistedCommits: number;
  aiAssistanceRate: number;
  lastCommit: string;
}

export interface DailyRepoCommitStats {
  date: string;
  totalCommits: number;
  claudeCodeCommits: number;
  cursorCommits: number;
  copilotCommits: number;
  windsurfCommits: number;
}

export async function getRepositoryByFullName(
  source: string,
  fullName: string
): Promise<{ id: number; source: string; fullName: string } | null> {
  const result = await db
    .select({
      id: repositories.id,
      source: repositories.source,
      fullName: repositories.fullName,
    })
    .from(repositories)
    .where(and(
      eq(repositories.source, source),
      eq(repositories.fullName, fullName)
    ));
  return result[0] || null;
}

export async function getRepositoryDetails(
  repoId: number,
  startDate?: string,
  endDate?: string
): Promise<RepositoryDetails | null> {
  const effectiveStartDate = startDate || '1970-01-01';
  const effectiveEndDate = endDate || '9999-12-31';

  const result = await sql<Omit<RepositoryDetails, 'aiAssistanceRate'>>`
    SELECT
      r.id,
      r.source,
      r.full_name as "fullName",
      COUNT(c.id)::int as "totalCommits",
      COUNT(c.id) FILTER (WHERE c.ai_tool IS NOT NULL)::int as "aiAssistedCommits",
      COALESCE(SUM(c.additions), 0)::int as "totalAdditions",
      COALESCE(SUM(c.deletions), 0)::int as "totalDeletions",
      COALESCE(SUM(c.additions) FILTER (WHERE c.ai_tool IS NOT NULL), 0)::int as "aiAdditions",
      COALESCE(SUM(c.deletions) FILTER (WHERE c.ai_tool IS NOT NULL), 0)::int as "aiDeletions",
      COUNT(DISTINCT c.author_email)::int as "uniqueAuthors",
      MIN(c.committed_at)::text as "firstCommit",
      MAX(c.committed_at)::text as "lastCommit",
      COUNT(c.id) FILTER (WHERE c.ai_tool = 'claude_code')::int as "claudeCodeCommits",
      COUNT(c.id) FILTER (WHERE c.ai_tool = 'cursor')::int as "cursorCommits",
      COUNT(c.id) FILTER (WHERE c.ai_tool = 'github_copilot')::int as "copilotCommits",
      COUNT(c.id) FILTER (WHERE c.ai_tool = 'windsurf')::int as "windsurfCommits"
    FROM repositories r
    LEFT JOIN commits c ON c.repo_id = r.id
      AND c.committed_at >= ${effectiveStartDate}::timestamp
      AND c.committed_at < (${effectiveEndDate}::date + interval '1 day')
    WHERE r.id = ${repoId}
    GROUP BY r.id, r.source, r.full_name
  `;

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    ...row,
    aiAssistanceRate: row.totalCommits > 0
      ? Math.round((row.aiAssistedCommits / row.totalCommits) * 100)
      : 0,
  };
}

export interface RepositoryDetailsPreviousPeriod {
  totalCommits: number;
  aiAssistedCommits: number;
  aiAssistanceRate: number;
  uniqueAuthors: number;
  totalAdditions: number;
  totalDeletions: number;
}

export interface RepositoryDetailsWithComparison extends RepositoryDetails {
  previousPeriod?: RepositoryDetailsPreviousPeriod;
}

export async function getRepositoryDetailsWithComparison(
  repoId: number,
  startDate: string,
  endDate: string
): Promise<RepositoryDetailsWithComparison | null> {
  const { prevStartDate, prevEndDate } = getPreviousPeriodDates(startDate, endDate);

  const [currentDetails, prevResult] = await Promise.all([
    getRepositoryDetails(repoId, startDate, endDate),
    sql<{
      totalCommits: number;
      aiAssistedCommits: number;
      uniqueAuthors: number;
      totalAdditions: number;
      totalDeletions: number;
    }>`
      SELECT
        COUNT(c.id)::int as "totalCommits",
        COUNT(c.id) FILTER (WHERE c.ai_tool IS NOT NULL)::int as "aiAssistedCommits",
        COUNT(DISTINCT c.author_email)::int as "uniqueAuthors",
        COALESCE(SUM(c.additions), 0)::int as "totalAdditions",
        COALESCE(SUM(c.deletions), 0)::int as "totalDeletions"
      FROM commits c
      WHERE c.repo_id = ${repoId}
        AND c.committed_at >= ${prevStartDate}::timestamp
        AND c.committed_at < (${prevEndDate}::date + interval '1 day')
    `
  ]);

  if (!currentDetails) return null;

  const prev = prevResult.rows[0];
  const prevTotalCommits = Number(prev.totalCommits);
  const prevAiAssistedCommits = Number(prev.aiAssistedCommits);

  return {
    ...currentDetails,
    previousPeriod: {
      totalCommits: prevTotalCommits,
      aiAssistedCommits: prevAiAssistedCommits,
      aiAssistanceRate: prevTotalCommits > 0
        ? Math.round((prevAiAssistedCommits / prevTotalCommits) * 100)
        : 0,
      uniqueAuthors: Number(prev.uniqueAuthors),
      totalAdditions: Number(prev.totalAdditions),
      totalDeletions: Number(prev.totalDeletions),
    },
  };
}

export interface RepositoryDataRange {
  firstCommit: string | null;
  lastCommit: string | null;
  totalCommits: number;
}

export async function getRepositoryDataRange(
  repoId: number
): Promise<RepositoryDataRange> {
  const result = await db
    .select({
      firstCommit: drizzleSql<string>`MIN(committed_at)::text`,
      lastCommit: drizzleSql<string>`MAX(committed_at)::text`,
      totalCommits: count(),
    })
    .from(commits)
    .where(eq(commits.repoId, repoId));

  const row = result[0];
  return {
    firstCommit: row?.firstCommit || null,
    lastCommit: row?.lastCommit || null,
    totalCommits: Number(row?.totalCommits) || 0,
  };
}

export async function getRepositoryCommits(
  repoId: number,
  source: string,
  startDate?: string,
  endDate?: string,
  limit: number = 100,
  offset: number = 0,
  aiFilter?: 'all' | 'ai' | 'human'
): Promise<{ commits: RepositoryCommit[]; totalCount: number }> {
  const effectiveStartDate = startDate || '1970-01-01';
  const effectiveEndDate = endDate || '9999-12-31';

  // Build filter condition
  let aiCondition = '';
  if (aiFilter === 'ai') {
    aiCondition = 'AND c.ai_tool IS NOT NULL';
  } else if (aiFilter === 'human') {
    aiCondition = 'AND c.ai_tool IS NULL';
  }

  const countResult = await query<{ count: number }>(`
    SELECT COUNT(*)::int as count
    FROM commits c
    WHERE c.repo_id = $1
      AND c.committed_at >= $2::timestamp
      AND c.committed_at < ($3::date + interval '1 day')
      ${aiCondition}
  `, [repoId, effectiveStartDate, effectiveEndDate]);

  const result = await query<RepositoryCommit & { id: number }>(`
    SELECT
      c.id,
      c.commit_id as "commitId",
      c.author_email as "authorEmail",
      im.email as "mappedEmail",
      c.committed_at::text as "committedAt",
      c.message,
      c.ai_tool as "aiTool",
      c.ai_model as "aiModel",
      COALESCE(c.additions, 0)::int as additions,
      COALESCE(c.deletions, 0)::int as deletions
    FROM commits c
    LEFT JOIN identity_mappings im ON im.source = $6 AND im.external_id = c.author_id
    WHERE c.repo_id = $1
      AND c.committed_at >= $2::timestamp
      AND c.committed_at < ($3::date + interval '1 day')
      ${aiCondition}
    ORDER BY c.committed_at DESC
    LIMIT $4 OFFSET $5
  `, [repoId, effectiveStartDate, effectiveEndDate, limit, offset, source]);

  // Fetch attributions for all commits in one query
  const commitIds = result.rows.map(r => r.id);
  const attributionsByCommitId: Map<number, CommitAttributionData[]> = new Map();

  if (commitIds.length > 0) {
    const attrResult = await query<CommitAttributionData & { commitId: number }>(`
      SELECT
        commit_id as "commitId",
        ai_tool as "aiTool",
        ai_model as "aiModel",
        confidence,
        source
      FROM commit_attributions
      WHERE commit_id = ANY($1)
      ORDER BY created_at ASC
    `, [commitIds]);

    for (const row of attrResult.rows) {
      const existing = attributionsByCommitId.get(row.commitId) || [];
      existing.push({
        aiTool: row.aiTool,
        aiModel: row.aiModel,
        confidence: row.confidence,
        source: row.source,
      });
      attributionsByCommitId.set(row.commitId, existing);
    }
  }

  const commits: RepositoryCommit[] = result.rows.map(row => ({
    ...row,
    attributions: attributionsByCommitId.get(row.id) || [],
  }));

  return {
    commits,
    totalCount: countResult.rows[0].count,
  };
}

export async function getRepositoryAuthors(
  repoId: number,
  startDate?: string,
  endDate?: string,
  limit: number = 20
): Promise<RepositoryAuthor[]> {
  const effectiveStartDate = startDate || '1970-01-01';
  const effectiveEndDate = endDate || '9999-12-31';

  const result = await sql<Omit<RepositoryAuthor, 'aiAssistanceRate'>>`
    SELECT
      c.author_email as "authorEmail",
      COUNT(*)::int as "totalCommits",
      COUNT(*) FILTER (WHERE c.ai_tool IS NOT NULL)::int as "aiAssistedCommits",
      MAX(c.committed_at)::text as "lastCommit"
    FROM commits c
    WHERE c.repo_id = ${repoId}
      AND c.committed_at >= ${effectiveStartDate}::timestamp
      AND c.committed_at < (${effectiveEndDate}::date + interval '1 day')
    GROUP BY c.author_email
    ORDER BY "totalCommits" DESC
    LIMIT ${limit}
  `;

  return result.rows.map(row => ({
    ...row,
    aiAssistanceRate: row.totalCommits > 0
      ? Math.round((row.aiAssistedCommits / row.totalCommits) * 100)
      : 0,
  }));
}

export async function getRepositoryDailyStats(
  repoId: number,
  startDate: string,
  endDate: string
): Promise<DailyRepoCommitStats[]> {
  const result = await sql<DailyRepoCommitStats>`
    WITH date_series AS (
      SELECT generate_series(
        ${startDate}::date,
        ${endDate}::date,
        '1 day'::interval
      )::date as date
    )
    SELECT
      ds.date::text,
      COALESCE(COUNT(c.id), 0)::int as "totalCommits",
      COALESCE(COUNT(c.id) FILTER (WHERE c.ai_tool = 'claude_code'), 0)::int as "claudeCodeCommits",
      COALESCE(COUNT(c.id) FILTER (WHERE c.ai_tool = 'cursor'), 0)::int as "cursorCommits",
      COALESCE(COUNT(c.id) FILTER (WHERE c.ai_tool = 'github_copilot'), 0)::int as "copilotCommits",
      COALESCE(COUNT(c.id) FILTER (WHERE c.ai_tool = 'windsurf'), 0)::int as "windsurfCommits"
    FROM date_series ds
    LEFT JOIN commits c ON c.committed_at::date = ds.date AND c.repo_id = ${repoId}
    GROUP BY ds.date
    ORDER BY ds.date ASC
  `;

  return result.rows;
}

// ============================================================================
// Model Trends (for Usage page)
// ============================================================================

export interface ModelTrendData {
  date: string;
  model: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  tool: string;
}

export async function getModelTrends(
  startDate: string,
  endDate: string
): Promise<ModelTrendData[]> {
  const result = await sql<ModelTrendData>`
    WITH date_series AS (
      SELECT generate_series(
        ${startDate}::date,
        ${endDate}::date,
        '1 day'::interval
      )::date as date
    ),
    model_data AS (
      SELECT
        date,
        model,
        tool,
        SUM(input_tokens + cache_write_tokens + cache_read_tokens + output_tokens)::bigint as tokens,
        SUM(input_tokens)::bigint as "inputTokens",
        SUM(output_tokens)::bigint as "outputTokens",
        SUM(cost)::float as cost
      FROM usage_records
      WHERE date >= ${startDate} AND date <= ${endDate}
      GROUP BY date, model, tool
    )
    SELECT
      ds.date::text,
      COALESCE(md.model, 'unknown') as model,
      COALESCE(md.tool, 'unknown') as tool,
      COALESCE(md.tokens, 0)::bigint as tokens,
      COALESCE(md."inputTokens", 0)::bigint as "inputTokens",
      COALESCE(md."outputTokens", 0)::bigint as "outputTokens",
      COALESCE(md.cost, 0)::float as cost
    FROM date_series ds
    LEFT JOIN model_data md ON md.date = ds.date
    WHERE md.model IS NOT NULL
    ORDER BY ds.date ASC, md.tokens DESC
  `;

  return result.rows;
}

export interface ToolTrendData {
  date: string;
  tool: string;
  tokens: number;
  cost: number;
  users: number;
}

export async function getToolTrends(
  startDate: string,
  endDate: string
): Promise<ToolTrendData[]> {
  const result = await sql<ToolTrendData>`
    WITH date_series AS (
      SELECT generate_series(
        ${startDate}::date,
        ${endDate}::date,
        '1 day'::interval
      )::date as date
    ),
    tool_data AS (
      SELECT
        date,
        tool,
        SUM(input_tokens + cache_write_tokens + cache_read_tokens + output_tokens)::bigint as tokens,
        SUM(cost)::float as cost,
        COUNT(DISTINCT email)::int as users
      FROM usage_records
      WHERE date >= ${startDate} AND date <= ${endDate}
      GROUP BY date, tool
    )
    SELECT
      ds.date::text,
      COALESCE(td.tool, 'unknown') as tool,
      COALESCE(td.tokens, 0)::bigint as tokens,
      COALESCE(td.cost, 0)::float as cost,
      COALESCE(td.users, 0)::int as users
    FROM date_series ds
    LEFT JOIN tool_data td ON td.date = ds.date
    WHERE td.tool IS NOT NULL
    ORDER BY ds.date ASC, td.tokens DESC
  `;

  return result.rows;
}

// ============================================================================
// User Commit Stats (AI attribution per user)
// ============================================================================

export interface UserCommitStats {
  totalCommits: number;
  aiAssistedCommits: number;
  aiAssistanceRate: number;
  toolBreakdown: {
    tool: string;
    commits: number;
  }[];
}

export async function getUserCommitStats(
  email: string,
  startDate?: string,
  endDate?: string
): Promise<UserCommitStats> {
  const effectiveStartDate = startDate || '1970-01-01';
  const effectiveEndDate = endDate || '9999-12-31';

  const [overallResult, toolBreakdownResult] = await Promise.all([
    sql<{ totalCommits: number; aiAssistedCommits: number }>`
      SELECT
        COUNT(*)::int as "totalCommits",
        COUNT(*) FILTER (WHERE ai_tool IS NOT NULL)::int as "aiAssistedCommits"
      FROM commits
      WHERE author_email = ${email}
        AND committed_at >= ${effectiveStartDate}::timestamp
        AND committed_at < (${effectiveEndDate}::date + interval '1 day')
    `,
    sql<{ tool: string; commits: number }>`
      SELECT
        ai_tool as tool,
        COUNT(*)::int as commits
      FROM commits
      WHERE author_email = ${email}
        AND ai_tool IS NOT NULL
        AND committed_at >= ${effectiveStartDate}::timestamp
        AND committed_at < (${effectiveEndDate}::date + interval '1 day')
      GROUP BY ai_tool
      ORDER BY commits DESC
    `
  ]);

  const overall = overallResult.rows[0];
  const totalCommits = Number(overall.totalCommits);
  const aiAssistedCommits = Number(overall.aiAssistedCommits);

  return {
    totalCommits,
    aiAssistedCommits,
    aiAssistanceRate: totalCommits > 0 ? Math.round((aiAssistedCommits / totalCommits) * 100) : 0,
    toolBreakdown: toolBreakdownResult.rows.map(row => ({
      tool: row.tool,
      commits: Number(row.commits),
    })),
  };
}

// ============================================================================
// Raw Usage Records (for user profile detail view)
// ============================================================================

export interface RawUsageRecord {
  id: number;
  date: string;
  tool: string;
  model: string;
  totalTokens: number;
  cost: number;
}

export interface RawUsageResult {
  records: RawUsageRecord[];
  totalCount: number;
}

export async function getUserRawUsage(
  email: string,
  startDate: string,
  endDate: string,
  page: number = 0,
  limit: number = 50,
  toolFilter?: string,
  modelFilter?: string
): Promise<RawUsageResult> {
  const offset = page * limit;

  // Build filter conditions
  let toolCondition = '';
  let modelCondition = '';
  const params: (string | number)[] = [email, startDate, endDate];

  if (toolFilter) {
    params.push(toolFilter);
    toolCondition = `AND tool = $${params.length}`;
  }
  if (modelFilter) {
    params.push(modelFilter);
    modelCondition = `AND model = $${params.length}`;
  }

  params.push(limit, offset);

  const [recordsResult, countResult] = await Promise.all([
    query<RawUsageRecord>(`
      SELECT
        id,
        date::text,
        tool,
        model,
        (input_tokens + cache_write_tokens + cache_read_tokens + output_tokens)::bigint as "totalTokens",
        cost::float
      FROM usage_records
      WHERE email = $1
        AND date >= $2 AND date <= $3
        ${toolCondition}
        ${modelCondition}
      ORDER BY date DESC, id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params),
    query<{ count: number }>(`
      SELECT COUNT(*)::int as count
      FROM usage_records
      WHERE email = $1
        AND date >= $2 AND date <= $3
        ${toolCondition}
        ${modelCondition}
    `, params.slice(0, -2)) // Exclude limit and offset for count
  ]);

  return {
    records: recordsResult.rows.map(row => ({
      ...row,
      totalTokens: Number(row.totalTokens),
      cost: Number(row.cost),
    })) as RawUsageRecord[],
    totalCount: countResult.rows[0].count,
  };
}

export interface UsageFilters {
  tools: string[];
  models: string[];
}

export async function getUserUsageFilters(
  email: string,
  startDate: string,
  endDate: string
): Promise<UsageFilters> {
  const [toolsResult, modelsResult] = await Promise.all([
    sql<{ tool: string }>`
      SELECT DISTINCT tool
      FROM usage_records
      WHERE email = ${email}
        AND date >= ${startDate} AND date <= ${endDate}
      ORDER BY tool ASC
    `,
    sql<{ model: string }>`
      SELECT DISTINCT model
      FROM usage_records
      WHERE email = ${email}
        AND date >= ${startDate} AND date <= ${endDate}
      ORDER BY model ASC
    `
  ]);

  return {
    tools: toolsResult.rows.map(r => r.tool),
    models: modelsResult.rows.map(r => r.model),
  };
}
