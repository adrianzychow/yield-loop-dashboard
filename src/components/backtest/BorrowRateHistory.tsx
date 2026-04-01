"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { HourlyDataPoint } from "@/lib/backtester/types";

interface BorrowRateHistoryProps {
  data: HourlyDataPoint[];
}

interface BorrowStats {
  avg30d: number;
  avg90d: number;
  vol90d: number; // annualized volatility
}

function computeBorrowStats(data: HourlyDataPoint[]): BorrowStats {
  if (data.length === 0) return { avg30d: 0, avg90d: 0, vol90d: 0 };

  const now = data[data.length - 1].timestamp;
  const ts30d = now - 30 * 86400;
  const ts90d = now - 90 * 86400;

  let sum30 = 0, count30 = 0;
  let sum90 = 0, count90 = 0;

  for (const p of data) {
    if (p.timestamp >= ts30d) { sum30 += p.borrowApy; count30++; }
    if (p.timestamp >= ts90d) { sum90 += p.borrowApy; count90++; }
  }

  // 90d annualized volatility of APR
  // Group into daily averages, then compute std dev and annualize
  const dailyRates: number[] = [];
  const HOURS = 24;
  let daySum = 0;
  let dayCount = 0;
  const d90 = data.filter((p) => p.timestamp >= ts90d);

  for (let i = 0; i < d90.length; i++) {
    daySum += d90[i].borrowApy;
    dayCount++;
    if (dayCount === HOURS || i === d90.length - 1) {
      dailyRates.push(daySum / dayCount);
      daySum = 0;
      dayCount = 0;
    }
  }

  let vol90d = 0;
  if (dailyRates.length > 1) {
    const mean = dailyRates.reduce((a, b) => a + b, 0) / dailyRates.length;
    const variance = dailyRates.reduce((a, v) => a + (v - mean) ** 2, 0) / (dailyRates.length - 1);
    vol90d = Math.sqrt(variance) * Math.sqrt(365); // annualize daily vol
  }

  return {
    avg30d: count30 > 0 ? sum30 / count30 : 0,
    avg90d: count90 > 0 ? sum90 / count90 : 0,
    vol90d,
  };
}

export default function BorrowRateHistory({ data }: BorrowRateHistoryProps) {
  const stats = computeBorrowStats(data);

  const step = Math.max(1, Math.floor(data.length / 600));
  const chartData = data
    .filter((_, i) => i % step === 0 || i === data.length - 1)
    .map((p) => ({
      date: new Date(p.timestamp * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      borrowApr: Math.round(p.borrowApy * 10000) / 100, // as %
    }));

  return (
    <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-6">
      <h3 className="text-lg font-semibold text-gray-200 mb-1">
        Historical Borrow APR
      </h3>
      <p className="text-sm text-gray-500 mb-4">
        Morpho market borrow rate over time
      </p>

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-3 mb-5">
        <div className="bg-gray-900/50 rounded-lg px-3 py-2">
          <div className="text-xs text-gray-500">30d Average APR</div>
          <div className="text-sm font-semibold text-gray-200">
            {(stats.avg30d * 100).toFixed(2)}%
          </div>
        </div>
        <div className="bg-gray-900/50 rounded-lg px-3 py-2">
          <div className="text-xs text-gray-500">90d Average APR</div>
          <div className="text-sm font-semibold text-gray-200">
            {(stats.avg90d * 100).toFixed(2)}%
          </div>
        </div>
        <div className="bg-gray-900/50 rounded-lg px-3 py-2">
          <div className="text-xs text-gray-500">90d Annualized Volatility</div>
          <div className="text-sm font-semibold text-gray-200">
            {(stats.vol90d * 100).toFixed(2)}%
          </div>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
          <XAxis dataKey="date" stroke="#6b7280" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
          <YAxis stroke="#6b7280" tick={{ fontSize: 10 }} tickFormatter={(v) => `${v.toFixed(1)}%`} />
          <Tooltip
            contentStyle={{ backgroundColor: "#111827", border: "1px solid #374151", borderRadius: "8px" }}
            formatter={(value) => [`${Number(value).toFixed(2)}%`, "Borrow APR"]}
            labelStyle={{ color: "#9ca3af" }}
          />
          <Line type="monotone" dataKey="borrowApr" stroke="#ef4444" strokeWidth={1.5} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
