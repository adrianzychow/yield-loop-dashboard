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
  Area,
  ComposedChart,
} from "recharts";
import type { BacktestResult } from "@/lib/backtester/types";

interface HealthFactorChartProps {
  result: BacktestResult;
}

export default function HealthFactorChart({ result }: HealthFactorChartProps) {
  const step = Math.max(1, Math.floor(result.snapshots.length / 500));
  const chartData = result.snapshots
    .filter((_, i) => i % step === 0 || i === result.snapshots.length - 1)
    .map((s) => ({
      timestamp: s.timestamp,
      date: new Date(s.timestamp * 1000).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      }),
      healthFactor: Math.round(s.healthFactor * 1000) / 1000,
      borrowApy: Math.round(s.borrowApy * 10000) / 100, // as %
      oraclePrice: Math.round(s.oraclePrice * 10000) / 10000,
    }));

  return (
    <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-6">
      <div className="flex justify-between items-start mb-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-200">
            Health Factor & Oracle Price
          </h3>
          <p className="text-sm text-gray-500">
            Liquidation at HF {"<"} 1.0 | Min HF:{" "}
            <span
              className={
                result.minHealthFactor > 1.3
                  ? "text-emerald-400"
                  : result.minHealthFactor > 1.1
                    ? "text-amber-400"
                    : "text-red-400"
              }
            >
              {result.minHealthFactor.toFixed(3)}
            </span>{" "}
            on{" "}
            {new Date(
              result.minHealthFactorTimestamp * 1000
            ).toLocaleDateString()}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Health Factor */}
        <div>
          <div className="text-sm text-gray-400 mb-2">Health Factor</div>
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis
                dataKey="date"
                stroke="#6b7280"
                tick={{ fontSize: 10 }}
                interval="preserveStartEnd"
              />
              <YAxis
                stroke="#6b7280"
                tick={{ fontSize: 10 }}
                domain={["auto", "auto"]}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#111827",
                  border: "1px solid #374151",
                  borderRadius: "8px",
                }}
                formatter={(value) => [
                  Number(value).toFixed(3),
                  "Health Factor",
                ]}
                labelStyle={{ color: "#9ca3af" }}
              />
              <ReferenceLine
                y={1.0}
                stroke="#ef4444"
                strokeDasharray="5 5"
                label={{
                  value: "Liquidation",
                  position: "right",
                  fill: "#ef4444",
                  fontSize: 10,
                }}
              />
              <ReferenceLine
                y={1.3}
                stroke="#f59e0b"
                strokeDasharray="3 3"
                label={{
                  value: "Warning",
                  position: "right",
                  fill: "#f59e0b",
                  fontSize: 10,
                }}
              />
              <Area
                type="monotone"
                dataKey="healthFactor"
                fill="#10b98120"
                stroke="none"
              />
              <Line
                type="monotone"
                dataKey="healthFactor"
                stroke="#10b981"
                strokeWidth={1.5}
                dot={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* Oracle Price */}
        <div>
          <div className="text-sm text-gray-400 mb-2">Oracle Price (sUSDS/USDT)</div>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis
                dataKey="date"
                stroke="#6b7280"
                tick={{ fontSize: 10 }}
                interval="preserveStartEnd"
              />
              <YAxis
                stroke="#6b7280"
                tick={{ fontSize: 10 }}
                domain={["auto", "auto"]}
                tickFormatter={(v) => `$${v.toFixed(3)}`}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#111827",
                  border: "1px solid #374151",
                  borderRadius: "8px",
                }}
                formatter={(value) => [
                  `$${Number(value).toFixed(4)}`,
                  "Oracle Price",
                ]}
                labelStyle={{ color: "#9ca3af" }}
              />
              <Line
                type="monotone"
                dataKey="oraclePrice"
                stroke="#3b82f6"
                strokeWidth={1.5}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
