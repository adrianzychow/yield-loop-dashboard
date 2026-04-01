"use client";

import { HistoricalDataPoint } from "@/lib/types";

interface Props {
  apyData: HistoricalDataPoint[];
}

export default function AprSummary({ apyData }: Props) {
  if (apyData.length === 0) return null;

  const now = Math.floor(Date.now() / 1000);
  const d30ago = now - 30 * 86400;
  const d90ago = now - 90 * 86400;

  const last30 = apyData.filter((d) => d.timestamp >= d30ago);
  const last90 = apyData.filter((d) => d.timestamp >= d90ago);

  const avg = (arr: HistoricalDataPoint[]) =>
    arr.length > 0 ? arr.reduce((s, d) => s + d.value, 0) / arr.length : 0;

  const avg30 = avg(last30);
  const avg90 = avg(last90);

  // 90d annualized volatility: std dev of daily returns × sqrt(365)
  // Group by day and compute daily avg APY, then compute vol of day-to-day changes
  const dailyMap = new Map<number, number[]>();
  for (const d of last90) {
    const dayKey = Math.floor(d.timestamp / 86400) * 86400;
    if (!dailyMap.has(dayKey)) dailyMap.set(dayKey, []);
    dailyMap.get(dayKey)!.push(d.value);
  }

  const dailyAvgs = Array.from(dailyMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([, vals]) => vals.reduce((s, v) => s + v, 0) / vals.length);

  let vol90 = 0;
  if (dailyAvgs.length > 1) {
    const changes: number[] = [];
    for (let i = 1; i < dailyAvgs.length; i++) {
      if (dailyAvgs[i - 1] !== 0) {
        changes.push((dailyAvgs[i] - dailyAvgs[i - 1]) / dailyAvgs[i - 1]);
      }
    }
    if (changes.length > 0) {
      const meanChange = changes.reduce((s, c) => s + c, 0) / changes.length;
      const variance =
        changes.reduce((s, c) => s + (c - meanChange) ** 2, 0) / changes.length;
      vol90 = Math.sqrt(variance) * Math.sqrt(365) * 100; // annualized, in %
    }
  }

  return (
    <div className="bg-gray-800/30 rounded-xl border border-gray-700/50 p-4">
      <h4 className="text-sm font-medium text-gray-400 mb-3">APR Summary</h4>
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-gray-900/50 rounded-lg px-4 py-3 text-center">
          <div className="text-xs text-gray-500 mb-1">30d Avg APR</div>
          <div className="text-lg font-semibold text-emerald-400">
            {avg30.toFixed(2)}%
          </div>
        </div>
        <div className="bg-gray-900/50 rounded-lg px-4 py-3 text-center">
          <div className="text-xs text-gray-500 mb-1">90d Avg APR</div>
          <div className="text-lg font-semibold text-amber-400">
            {avg90.toFixed(2)}%
          </div>
        </div>
        <div className="bg-gray-900/50 rounded-lg px-4 py-3 text-center">
          <div className="text-xs text-gray-500 mb-1">90d Ann. Volatility</div>
          <div className="text-lg font-semibold text-gray-200">
            {vol90.toFixed(1)}%
          </div>
        </div>
      </div>
    </div>
  );
}
