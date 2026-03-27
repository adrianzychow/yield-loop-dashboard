"use client";

import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";
import { BorrowRateSeries, DateRange } from "@/lib/types";
import { formatChartDate } from "@/lib/chartUtils";
import ChartEmptyState from "./ChartEmptyState";

interface Props {
  series: BorrowRateSeries[];
  range: DateRange;
}

/**
 * Merge multiple time series onto a common time axis.
 * Uses forward-fill for missing values at each timestamp.
 */
function mergeSeriesData(
  series: BorrowRateSeries[]
): Record<string, number | null>[] {
  const tsSet = new Set<number>();
  for (const s of series) {
    for (const d of s.data) tsSet.add(d.timestamp);
  }
  const timestamps = Array.from(tsSet).sort((a, b) => a - b);

  return timestamps.map((ts) => {
    const row: Record<string, number | null> = { timestamp: ts };
    for (const s of series) {
      let closest: number | null = null;
      for (const d of s.data) {
        if (d.timestamp <= ts) closest = d.value;
        else break;
      }
      row[s.config.label] = closest;
    }
    return row;
  });
}

export default function BorrowRatesChart({ series, range }: Props) {
  if (series.length === 0) {
    return <ChartEmptyState label="No borrow rate history available" />;
  }

  const merged = mergeSeriesData(series);
  const formatted = merged.map((row) => ({
    ...row,
    date: formatChartDate(row.timestamp as number, range),
  }));

  return (
    <div className="bg-gray-800/30 rounded-xl border border-gray-700/50 p-4">
      <h4 className="text-sm font-medium text-gray-400 mb-3">
        Borrow Rates by Venue (%)
      </h4>
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={formatted}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
          <XAxis
            dataKey="date"
            tick={{ fill: "#9ca3af", fontSize: 11 }}
            axisLine={{ stroke: "#374151" }}
            tickLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fill: "#9ca3af", fontSize: 11 }}
            axisLine={{ stroke: "#374151" }}
            tickLine={false}
            tickFormatter={(v: number) => `${v.toFixed(1)}%`}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "#111827",
              border: "1px solid #374151",
              borderRadius: "8px",
              color: "#e5e7eb",
              fontSize: 12,
            }}
            labelStyle={{ color: "#9ca3af", marginBottom: 4 }}
            formatter={(value, name) =>
              value !== null && value !== undefined
                ? [`${Number(value).toFixed(2)}%`, String(name)]
                : ["N/A", String(name)]
            }
          />
          <Legend wrapperStyle={{ color: "#9ca3af", fontSize: 12 }} />
          {series.map((s) => (
            <Line
              key={s.config.label}
              type="monotone"
              dataKey={s.config.label}
              stroke={s.config.color}
              dot={false}
              strokeWidth={1.5}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
