"use client";

import { StrategyRow } from "@/lib/types";
import { formatPct, formatUsd } from "@/lib/utils";

interface AssetDetailProps {
  strategy: StrategyRow;
}

export default function AssetDetail({ strategy }: AssetDetailProps) {
  const { asset, baseYield, bestBorrow, spread, net3x, net5x, allBorrowMarkets } = strategy;

  // Sort by borrow rate ascending
  const sortedMarkets = [...allBorrowMarkets].sort(
    (a, b) => a.borrowRate - b.borrowRate
  );

  return (
    <div>
      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
        <StatCard label="Base Yield" value={formatPct(baseYield)} accent="emerald" />
        <StatCard
          label="Best Borrow Rate"
          value={formatPct(bestBorrow?.borrowRate ?? null)}
          accent="amber"
        />
        <StatCard label="Spread" value={formatPct(spread)} accent={spread && spread > 0 ? "emerald" : "red"} />
        <StatCard label="Net Yield 3x" value={formatPct(net3x)} accent="emerald" />
        <StatCard label="Net Yield 5x" value={formatPct(net5x)} accent="emerald" />
      </div>

      {/* Borrow venues table */}
      <h3 className="text-lg font-semibold text-white mb-3">
        Borrow Venues for {asset.displayName}
      </h3>
      <div className="overflow-x-auto rounded-xl border border-gray-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-800/50 text-gray-400 text-left">
              <th className="px-4 py-3 font-medium">Venue</th>
              <th className="px-4 py-3 font-medium">Pair</th>
              <th className="px-4 py-3 font-medium">Borrow Rate</th>
              <th className="px-4 py-3 font-medium">Available Liquidity</th>
              <th className="px-4 py-3 font-medium">Link</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {sortedMarkets.map((m, i) => {
              const isBest = bestBorrow && m.borrowRate === bestBorrow.borrowRate && m.venue === bestBorrow.venue;
              return (
                <tr
                  key={`${m.venue}-${m.pair}-${i}`}
                  className={`${isBest ? "bg-emerald-900/20" : ""} hover:bg-gray-800/40 transition-colors`}
                >
                  <td className="px-4 py-3 text-gray-200">
                    {m.venue}
                    {isBest && (
                      <span className="ml-2 text-xs px-2 py-0.5 rounded bg-emerald-800 text-emerald-300">
                        Best
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-300 font-mono">{m.pair}</td>
                  <td className="px-4 py-3 font-mono text-amber-400">
                    {formatPct(m.borrowRate)}
                  </td>
                  <td className="px-4 py-3 font-mono text-gray-300">
                    {formatUsd(m.liquidity)}
                  </td>
                  <td className="px-4 py-3">
                    <a
                      href={m.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-400 hover:text-blue-300 underline text-xs"
                    >
                      View Market ↗
                    </a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {sortedMarkets.length === 0 && (
          <div className="text-center text-gray-500 py-8">
            No borrow markets found for this asset
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: string;
}) {
  const colorMap: Record<string, string> = {
    emerald: "text-emerald-400",
    red: "text-red-400",
    amber: "text-amber-400",
    gray: "text-gray-400",
  };
  return (
    <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700/50">
      <div className="text-gray-400 text-xs uppercase tracking-wide mb-1">{label}</div>
      <div className={`text-xl font-mono font-bold ${colorMap[accent] ?? "text-gray-200"}`}>
        {value}
      </div>
    </div>
  );
}
