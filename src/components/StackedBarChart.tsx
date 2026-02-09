'use client';

import { useMemo } from 'react';
import { BaseStackedBarChart, type StackedBarSegment, type StackedBarDataPoint } from './BaseStackedBarChart';
import { formatTokens } from '@/lib/utils';
import { aggregateToWeekly } from '@/lib/dateUtils';
import { TOOL_CONFIGS } from '@/lib/tools';

interface DailyUsage {
  date: string;
  claudeCode: number;
  cursor: number;
  bedrock: number;
  cost?: number;
}

interface StackedBarChartProps {
  data: DailyUsage[];
  height?: number;
  showLabels?: boolean;
}

const AGGREGATION_THRESHOLD = 90;

// Define segments for the usage chart (rendered bottom to top in stack)
// Uses centralized tool colors from lib/tools.ts
const USAGE_SEGMENTS: StackedBarSegment[] = [
  {
    key: 'cursor',
    label: TOOL_CONFIGS.cursor.name,
    color: TOOL_CONFIGS.cursor.bgChart,
    textColor: TOOL_CONFIGS.cursor.text,
  },
  {
    key: 'bedrock',
    label: TOOL_CONFIGS.bedrock.name,
    color: TOOL_CONFIGS.bedrock.bgChart,
    textColor: TOOL_CONFIGS.bedrock.text,
  },
  {
    key: 'claudeCode',
    label: TOOL_CONFIGS.claude_code.name,
    color: TOOL_CONFIGS.claude_code.bgChart,
    textColor: TOOL_CONFIGS.claude_code.text,
  },
];

export function StackedBarChart({ data, height = 200, showLabels = true }: StackedBarChartProps) {
  // Auto-aggregate to weekly when >90 data points
  const { displayData, isWeekly } = useMemo(() => {
    if (data.length > AGGREGATION_THRESHOLD) {
      return { displayData: aggregateToWeekly(data), isWeekly: true };
    }
    return { displayData: data, isWeekly: false };
  }, [data]);

  // Transform data to BaseStackedBarChart format
  const chartData: StackedBarDataPoint[] = displayData.map(d => ({
    date: d.date,
    values: {
      claudeCode: Number(d.claudeCode),
      cursor: Number(d.cursor),
      bedrock: Number(d.bedrock),
    },
  }));

  // Calculate totals for custom legend (from original data, not aggregated)
  const claudeCodeTotal = data.reduce((sum, d) => sum + Number(d.claudeCode), 0);
  const cursorTotal = data.reduce((sum, d) => sum + Number(d.cursor), 0);
  const bedrockTotal = data.reduce((sum, d) => sum + Number(d.bedrock), 0);

  // Custom legend with token formatting
  const legendContent = (
    <div className="flex gap-4">
      <span className={`font-mono text-xs ${TOOL_CONFIGS.claude_code.text}`}>
        {TOOL_CONFIGS.claude_code.name}: {formatTokens(claudeCodeTotal)}
      </span>
      {bedrockTotal > 0 && (
        <span className={`font-mono text-xs ${TOOL_CONFIGS.bedrock.text}`}>
          {TOOL_CONFIGS.bedrock.name}: {formatTokens(bedrockTotal)}
        </span>
      )}
      <span className={`font-mono text-xs ${TOOL_CONFIGS.cursor.text}`}>
        {TOOL_CONFIGS.cursor.name}: {formatTokens(cursorTotal)}
      </span>
    </div>
  );

  return (
    <BaseStackedBarChart
      title={isWeekly ? 'Weekly Usage' : 'Daily Usage'}
      subtitle={`(${data.length} days)`}
      data={chartData}
      segments={USAGE_SEGMENTS}
      height={height}
      showLabels={showLabels}
      formatValue={formatTokens}
      legendContent={legendContent}
    />
  );
}
