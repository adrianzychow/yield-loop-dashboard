"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import type { CapacityResult } from "@/lib/backtester/types";

interface CapacityCurveProps {
  result: CapacityResult;
}

export default function CapacityCurve({ result }: CapacityCurveProps) {
  const chartData = result.points.map((p) => ({
    size: p.capitalUsd,
    sizeLabel: formatSize(p.capitalUsd),
    netApy: Math.round(p.netApy * 10000) / 100, // as %
    borrowApy: Math.round(p.estimatedBorrowApy * 10000) / 100,
    utilization: Math.round(p.newUtilization * 10000) / 100,
  }));

  return (
    <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-6">
      <div className="flex justify-between items-start mb-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-200">
            Capacity Analysis
          </h3>
          <p className="text-sm text-gray-500">
            How strategy size impacts returns via borrow rate IRM
          </p>
        </div>
        <div className="grid grid-cols-3 gap-3 text-right text-sm">
          <div>
            <div className="text-gray-500">Optimal Size</div>
            <div className="text-emerald-400 font-semibold">
              {formatSize(result.optimalSize)}
            </div>
          </div>
          <div>
            <div className="text-gray-500">Max Safe</div>
            <div className="text-amber-400 font-semibold">
              {formatSize(result.maxSafeSize)}
            </div>
          </div>
          <div>
            <div className="text-gray-500">Break-even</div>
            <div className="text-red-400 font-semibold">
              {formatSize(result.breakEvenSize)}
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Net APY vs Size */}
        <div>
          <div className="text-sm text-gray-400 mb-2">Net APY vs Strategy Size</div>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis
                dataKey="sizeLabel"
                stroke="#6b7280"
                tick={{ fontSize: 10 }}
                interval="preserveStartEnd"
              />
              <YAxis
                stroke="#6b7280"
                tick={{ fontSize: 10 }}
                tickFormatter={(v) => `${v.toFixed(1)}%`}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#111827",
                  border: "1px solid #374151",
                  borderRadius: "8px",
                }}
                formatter={(value) => [
                  `${Number(value).toFixed(2)}%`,
                  "Net APY",
                ]}
                labelStyle={{ color: "#9ca3af" }}
              />
              <ReferenceLine y={0} stroke="#ef4444" strokeDasharray="5 5" />
              <Line
                type="monotone"
                dataKey="netApy"
                stroke="#10b981"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Utilization Impact */}
        <div>
          <div className="text-sm text-gray-400 mb-2">
            Market Utilization Impact
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis
                dataKey="sizeLabel"
                stroke="#6b7280"
                tick={{ fontSize: 10 }}
                interval="preserveStartEnd"
              />
              <YAxis
                stroke="#6b7280"
                tick={{ fontSize: 10 }}
                tickFormatter={(v) => `${v.toFixed(0)}%`}
                domain={[0, 100]}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#111827",
                  border: "1px solid #374151",
                  borderRadius: "8px",
                }}
                formatter={(value, name) => [
                  `${Number(value).toFixed(2)}%`,
                  name === "utilization" ? "Utilization" : "Borrow APY",
                ]}
                labelStyle={{ color: "#9ca3af" }}
              />
              <ReferenceLine
                y={95}
                stroke="#ef4444"
                strokeDasharray="5 5"
                label={{
                  value: "95% danger",
                  position: "right",
                  fill: "#ef4444",
                  fontSize: 10,
                }}
              />
              <ReferenceLine
                y={90}
                stroke="#f59e0b"
                strokeDasharray="3 3"
                label={{
                  value: "90% target",
                  position: "right",
                  fill: "#f59e0b",
                  fontSize: 10,
                }}
              />
              <Line
                type="monotone"
                dataKey="utilization"
                stroke="#3b82f6"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

function formatSize(usd: number): string {
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(0)}K`;
  return `$${usd.toFixed(0)}`;
}
