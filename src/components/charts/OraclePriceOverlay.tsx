"use client";

import { useEffect, useState, useRef } from "react";
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
import { HistoricalDataPoint, DateRange } from "@/lib/types";
import { formatChartDate, rangeToDays } from "@/lib/chartUtils";
import ChartEmptyState from "./ChartEmptyState";
import {
  getClient,
  resolveHourlyBlocks,
  batchGetOracleSnapshots,
  SUSDS_VAULT,
} from "@/lib/backtester/onchain";

interface Props {
  coingeckoData: HistoricalDataPoint[];
  range: DateRange;
  assetName: string;
}

interface OraclePoint {
  timestamp: number;
  oraclePrice: number;
}

export default function OraclePriceOverlay({ coingeckoData, range, assetName }: Props) {
  const [oracleData, setOracleData] = useState<OraclePoint[]>([]);
  const [isLoadingOracle, setIsLoadingOracle] = useState(false);
  const loadedRange = useRef<string | null>(null);

  useEffect(() => {
    const rpcUrl = process.env.NEXT_PUBLIC_ETH_RPC_URL;
    if (!rpcUrl || loadedRange.current === range) return;

    let cancelled = false;
    loadedRange.current = range;

    const fetchOracle = async () => {
      setIsLoadingOracle(true);
      try {
        const days = rangeToDays(range);
        const now = Math.floor(Date.now() / 1000);
        const start = now - days * 86400;
        // Use wider intervals for longer periods
        const interval = days <= 30 ? 3600 * 4 : days <= 90 ? 3600 * 8 : 3600 * 12;

        const client = getClient(rpcUrl);
        const blocks = await resolveHourlyBlocks(client, start, now, interval);
        const snapshots = await batchGetOracleSnapshots(client, SUSDS_VAULT, blocks);

        if (!cancelled) {
          setOracleData(
            snapshots.map((s) => ({
              timestamp: s.timestamp,
              oraclePrice: (s.exchangeRate * s.basePrice) / s.quotePrice,
            }))
          );
        }
      } catch (err) {
        console.error("Oracle price fetch error:", err);
      } finally {
        if (!cancelled) setIsLoadingOracle(false);
      }
    };

    fetchOracle();
    return () => { cancelled = true; };
  }, [range]);

  if (coingeckoData.length === 0 && oracleData.length === 0) {
    return <ChartEmptyState label={`No price history for ${assetName}`} />;
  }

  // Merge CoinGecko + oracle data onto a common timeline
  const cgMap = new Map<number, number>();
  for (const d of coingeckoData) {
    const hourKey = Math.floor(d.timestamp / 3600) * 3600;
    cgMap.set(hourKey, d.value);
  }

  const oracleMap = new Map<number, number>();
  for (const d of oracleData) {
    const hourKey = Math.floor(d.timestamp / 3600) * 3600;
    oracleMap.set(hourKey, d.oraclePrice);
  }

  const allTimestamps = new Set<number>();
  for (const k of cgMap.keys()) allTimestamps.add(k);
  for (const k of oracleMap.keys()) allTimestamps.add(k);

  const sorted = Array.from(allTimestamps).sort((a, b) => a - b);

  // Forward-fill oracle data for gaps
  let lastOracle = 0;
  let lastCg = 0;
  const merged = sorted.map((ts) => {
    if (cgMap.has(ts)) lastCg = cgMap.get(ts)!;
    if (oracleMap.has(ts)) lastOracle = oracleMap.get(ts)!;
    return {
      timestamp: ts,
      date: formatChartDate(ts, range),
      coingecko: lastCg || undefined,
      oracle: lastOracle || undefined,
    };
  });

  // Compute deviation stats
  let maxDev = 0;
  let sumDev = 0;
  let devCount = 0;
  for (const m of merged) {
    if (m.coingecko && m.oracle) {
      const dev = Math.abs(m.oracle - m.coingecko) / m.coingecko;
      maxDev = Math.max(maxDev, dev);
      sumDev += dev;
      devCount++;
    }
  }
  const avgDev = devCount > 0 ? sumDev / devCount : 0;

  return (
    <div className="bg-gray-800/30 rounded-xl border border-gray-700/50 p-4">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-medium text-gray-400">
          Price (USD) — Oracle vs CoinGecko
        </h4>
        {isLoadingOracle && (
          <span className="text-xs text-amber-400 animate-pulse">Loading oracle data...</span>
        )}
      </div>

      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={merged}>
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
            domain={["auto", "auto"]}
            tickFormatter={(v: number) => `$${v.toFixed(4)}`}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "#111827",
              border: "1px solid #374151",
              borderRadius: "8px",
              color: "#e5e7eb",
            }}
            formatter={(value, name) => [
              `$${Number(value).toFixed(6)}`,
              name === "oracle" ? "Morpho Oracle" : "CoinGecko",
            ]}
          />
          <Legend />
          <Line
            type="monotone"
            dataKey="coingecko"
            name="CoinGecko"
            stroke="#10b981"
            dot={false}
            strokeWidth={1.5}
          />
          {oracleData.length > 0 && (
            <Line
              type="monotone"
              dataKey="oracle"
              name="Morpho Oracle"
              stroke="#f59e0b"
              dot={false}
              strokeWidth={1.5}
              strokeDasharray="4 2"
            />
          )}
        </LineChart>
      </ResponsiveContainer>

      {devCount > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-4 text-sm">
          <div className="bg-gray-900/50 rounded-lg px-3 py-2">
            <div className="text-gray-500 text-xs">Avg Deviation</div>
            <div className="text-gray-200">{(avgDev * 100).toFixed(3)}%</div>
          </div>
          <div className="bg-gray-900/50 rounded-lg px-3 py-2">
            <div className="text-gray-500 text-xs">Max Deviation</div>
            <div className="text-gray-200">{(maxDev * 100).toFixed(3)}%</div>
          </div>
        </div>
      )}
    </div>
  );
}
