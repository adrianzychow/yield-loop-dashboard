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
import type { BacktestResult } from "@/lib/backtester/types";

interface EquityChartProps {
  result: BacktestResult;
}

export default function EquityChart({ result }: EquityChartProps) {
  // Sample data for performance (max ~500 points for chart)
  const step = Math.max(1, Math.floor(result.snapshots.length / 500));
  const chartData = result.snapshots
    .filter((_, i) => i % step === 0 || i === result.snapshots.length - 1)
    .map((s) => ({
      timestamp: s.timestamp,
      date: new Date(s.timestamp * 1000).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      }),
      equity: Math.round(s.equity * 100) / 100,
      return: Math.round(s.cumulativeReturn * 10000) / 100, // as percentage
    }));

  const startingCapital = result.config.startingCapital;

  return (
    <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-6">
      <div className="flex justify-between items-start mb-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-200">
            Portfolio Equity
          </h3>
          <p className="text-sm text-gray-500">
            {result.totalHours.toLocaleString()} hours simulated
          </p>
        </div>
        <div className="text-right">
          <div
            className={`text-2xl font-bold ${
              result.finalEquity > startingCapital
                ? "text-emerald-400"
                : "text-red-400"
            }`}
          >
            ${result.finalEquity.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </div>
          <div
            className={`text-sm ${
              result.annualizedReturn > 0
                ? "text-emerald-400"
                : "text-red-400"
            }`}
          >
            {(result.annualizedReturn * 100).toFixed(2)}% annualized
          </div>
        </div>
      </div>

      {result.liquidated && (
        <div className="bg-red-900/30 border border-red-700 rounded-lg px-4 py-2 mb-4 text-sm text-red-300">
          Liquidated at{" "}
          {new Date(result.liquidationTimestamp! * 1000).toLocaleString()}
        </div>
      )}

      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
          <XAxis
            dataKey="date"
            stroke="#6b7280"
            tick={{ fontSize: 11 }}
            interval="preserveStartEnd"
          />
          <YAxis
            stroke="#6b7280"
            tick={{ fontSize: 11 }}
            tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
            domain={["auto", "auto"]}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "#111827",
              border: "1px solid #374151",
              borderRadius: "8px",
            }}
            formatter={(value) => [
              `$${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
              "Equity",
            ]}
            labelStyle={{ color: "#9ca3af" }}
          />
          <ReferenceLine
            y={startingCapital}
            stroke="#6b7280"
            strokeDasharray="5 5"
            label={{
              value: "Entry",
              position: "right",
              fill: "#6b7280",
              fontSize: 11,
            }}
          />
          <Line
            type="monotone"
            dataKey="equity"
            stroke="#10b981"
            strokeWidth={1.5}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>

      {/* Summary stats */}
      <div className="grid grid-cols-4 gap-4 mt-4 pt-4 border-t border-gray-700">
        <Stat
          label="Max Drawdown"
          value={`${(result.maxDrawdown * 100).toFixed(2)}%`}
          color={
            result.maxDrawdown < 0.05
              ? "text-emerald-400"
              : result.maxDrawdown < 0.15
                ? "text-amber-400"
                : "text-red-400"
          }
        />
        <Stat
          label="Min Health Factor"
          value={result.minHealthFactor.toFixed(3)}
          color={
            result.minHealthFactor > 1.3
              ? "text-emerald-400"
              : result.minHealthFactor > 1.1
                ? "text-amber-400"
                : "text-red-400"
          }
        />
        <Stat
          label="Avg Borrow APY"
          value={`${(result.avgBorrowApy * 100).toFixed(2)}%`}
          color="text-gray-200"
        />
        <Stat
          label="Entry Price"
          value={`$${result.entryOraclePrice.toFixed(4)}`}
          color="text-gray-200"
        />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-sm font-semibold ${color}`}>{value}</div>
    </div>
  );
}
