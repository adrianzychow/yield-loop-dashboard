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

interface OracleDeviationProps {
  data: HourlyDataPoint[];
  assetLabel?: string;
}

interface DeviationStats {
  maxDeviation: number;
  maxDeviationTs: number;
  avg30dDeviation: number;
  avg60dDeviation: number;
  trackingError: number;
  maxDrawdown: number;
  maxDrawdownTs: number;
}

function computeStats(data: HourlyDataPoint[]): DeviationStats {
  if (data.length === 0) {
    return { maxDeviation: 0, maxDeviationTs: 0, avg30dDeviation: 0, avg60dDeviation: 0, trackingError: 0, maxDrawdown: 0, maxDrawdownTs: 0 };
  }

  const now = data[data.length - 1].timestamp;
  const ts30d = now - 30 * 86400;
  const ts60d = now - 60 * 86400;

  let maxDev = 0;
  let maxDevTs = 0;
  let sum30d = 0;
  let count30d = 0;
  let sum60d = 0;
  let count60d = 0;

  // Compute hourly deviations
  const deviations: number[] = [];
  for (const p of data) {
    const dev = Math.abs((p.oraclePrice - p.coingeckoPrice) / p.coingeckoPrice);
    deviations.push(dev);

    if (dev > maxDev) {
      maxDev = dev;
      maxDevTs = p.timestamp;
    }
    if (p.timestamp >= ts30d) { sum30d += dev; count30d++; }
    if (p.timestamp >= ts60d) { sum60d += dev; count60d++; }
  }

  // Tracking error: annualized std dev of daily return differences
  // Group by day, compute daily returns for both series, then std dev of difference
  const dailyReturns: { oracle: number; cg: number }[] = [];
  const HOURS_PER_DAY = 24;
  for (let i = HOURS_PER_DAY; i < data.length; i += HOURS_PER_DAY) {
    const prev = data[i - HOURS_PER_DAY];
    const curr = data[i];
    const oracleRet = (curr.oraclePrice - prev.oraclePrice) / prev.oraclePrice;
    const cgRet = (curr.coingeckoPrice - prev.coingeckoPrice) / prev.coingeckoPrice;
    dailyReturns.push({ oracle: oracleRet, cg: cgRet });
  }

  let trackingError = 0;
  if (dailyReturns.length > 1) {
    const diffs = dailyReturns.map((r) => r.oracle - r.cg);
    const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const variance = diffs.reduce((a, d) => a + (d - mean) ** 2, 0) / (diffs.length - 1);
    trackingError = Math.sqrt(variance) * Math.sqrt(365); // annualize
  }

  // Max drawdown (on oracle price)
  let peak = data[0].oraclePrice;
  let maxDD = 0;
  let maxDDTs = 0;
  for (const p of data) {
    if (p.oraclePrice > peak) peak = p.oraclePrice;
    const dd = (peak - p.oraclePrice) / peak;
    if (dd > maxDD) {
      maxDD = dd;
      maxDDTs = p.timestamp;
    }
  }

  return {
    maxDeviation: maxDev,
    maxDeviationTs: maxDevTs,
    avg30dDeviation: count30d > 0 ? sum30d / count30d : 0,
    avg60dDeviation: count60d > 0 ? sum60d / count60d : 0,
    trackingError,
    maxDrawdown: maxDD,
    maxDrawdownTs: maxDDTs,
  };
}

export default function OracleDeviation({ data, assetLabel = "sUSDS" }: OracleDeviationProps) {
  const stats = computeStats(data);

  const isWstEth = assetLabel === "wstETH";
  const oracleDesc = isWstEth
    ? "On-chain oracle (Lido ratio + CAPO + Chainlink ETH/USD) vs CoinGecko wstETH/USD"
    : "On-chain oracle (Chainlink + vault rate) vs CoinGecko sUSDS/USD";

  // Sample for chart
  const step = Math.max(1, Math.floor(data.length / 600));
  const chartData = data
    .filter((_, i) => i % step === 0 || i === data.length - 1)
    .map((p) => ({
      date: new Date(p.timestamp * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      oracle: Math.round(p.oraclePrice * 10000) / 10000,
      coingecko: Math.round(p.coingeckoPrice * 10000) / 10000,
      spread: Math.round(((p.oraclePrice - p.coingeckoPrice) / p.coingeckoPrice) * 10000) / 100, // bps → %
    }));

  return (
    <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-6">
      <h3 className="text-lg font-semibold text-gray-200 mb-1">
        Oracle vs Off-Chain Price
      </h3>
      <p className="text-sm text-gray-500 mb-4">
        {oracleDesc}
      </p>

      {/* Summary stats */}
      <div className="grid grid-cols-5 gap-3 mb-5">
        <StatBox label="Max Deviation" value={`${(stats.maxDeviation * 100).toFixed(3)}%`}
          sub={stats.maxDeviationTs > 0 ? new Date(stats.maxDeviationTs * 1000).toLocaleDateString() : ""} />
        <StatBox label="30d Avg Deviation" value={`${(stats.avg30dDeviation * 100).toFixed(3)}%`} />
        <StatBox label="60d Avg Deviation" value={`${(stats.avg60dDeviation * 100).toFixed(3)}%`} />
        <StatBox label="Tracking Error (Ann.)" value={`${(stats.trackingError * 100).toFixed(3)}%`} />
        <StatBox label="Max Drawdown" value={`${(stats.maxDrawdown * 100).toFixed(3)}%`}
          sub={stats.maxDrawdownTs > 0 ? new Date(stats.maxDrawdownTs * 1000).toLocaleDateString() : ""}
          color={stats.maxDrawdown > 0.01 ? "text-red-400" : "text-emerald-400"} />
      </div>

      {/* Price overlay chart */}
      <div className="mb-4">
        <div className="text-sm text-gray-400 mb-2">Price Comparison</div>
        <ResponsiveContainer width="100%" height={250}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
            <XAxis dataKey="date" stroke="#6b7280" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
            <YAxis yAxisId="price" stroke="#6b7280" tick={{ fontSize: 10 }} domain={["auto", "auto"]}
              tickFormatter={(v) => `$${v.toFixed(3)}`} />
            <YAxis yAxisId="spread" orientation="right" stroke="#f59e0b" tick={{ fontSize: 10 }}
              tickFormatter={(v) => `${v.toFixed(2)}%`} />
            <Tooltip
              contentStyle={{ backgroundColor: "#111827", border: "1px solid #374151", borderRadius: "8px" }}
              formatter={(value, name) => {
                if (name === "spread") return [`${Number(value).toFixed(3)}%`, "Spread"];
                return [`$${Number(value).toFixed(4)}`, name === "oracle" ? "Oracle" : "CoinGecko"];
              }}
              labelStyle={{ color: "#9ca3af" }}
            />
            <Line yAxisId="price" type="monotone" dataKey="oracle" stroke="#10b981" strokeWidth={1.5} dot={false} name="oracle" />
            <Line yAxisId="price" type="monotone" dataKey="coingecko" stroke="#3b82f6" strokeWidth={1.5} dot={false} name="coingecko" />
            <Line yAxisId="spread" type="monotone" dataKey="spread" stroke="#f59e0b" strokeWidth={1} dot={false} name="spread" strokeDasharray="3 3" />
          </LineChart>
        </ResponsiveContainer>
        <div className="flex gap-4 mt-2 text-xs text-gray-500 justify-center">
          <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-emerald-500 inline-block" /> Oracle (on-chain)</span>
          <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-blue-500 inline-block" /> CoinGecko (off-chain)</span>
          <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-amber-500 inline-block border-dashed" /> Spread % (right axis)</span>
        </div>
      </div>
    </div>
  );
}

function StatBox({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-gray-900/50 rounded-lg px-3 py-2">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-sm font-semibold ${color ?? "text-gray-200"}`}>{value}</div>
      {sub && <div className="text-xs text-gray-600">{sub}</div>}
    </div>
  );
}
