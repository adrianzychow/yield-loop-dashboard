"use client";

import { StrategyRow } from "@/lib/types";
import { formatPct, formatUsd } from "@/lib/utils";

interface SummaryTableProps {
  strategies: StrategyRow[];
  onRowClick: (assetName: string) => void;
}

function PctCell({ value, positive }: { value: number | null; positive?: boolean }) {
  if (value === null) return <td className="px-4 py-3 text-gray-500">N/A</td>;
  const color =
    positive === undefined
      ? "text-gray-200"
      : value > 0
      ? "text-emerald-400"
      : value < 0
      ? "text-red-400"
      : "text-gray-400";
  return <td className={`px-4 py-3 font-mono ${color}`}>{formatPct(value)}</td>;
}

export default function SummaryTable({ strategies, onRowClick }: SummaryTableProps) {
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-800">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-800/50 text-gray-400 text-left">
            <th className="px-4 py-3 font-medium">Strategy</th>
            <th className="px-4 py-3 font-medium">Chain</th>
            <th className="px-4 py-3 font-medium">Base Yield</th>
            <th className="px-4 py-3 font-medium">Borrow Cost</th>
            <th className="px-4 py-3 font-medium">Borrow Liquidity</th>
            <th className="px-4 py-3 font-medium">Borrow Venue</th>
            <th className="px-4 py-3 font-medium">Spread</th>
            <th className="px-4 py-3 font-medium">Net 3x</th>
            <th className="px-4 py-3 font-medium">Net 5x</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800">
          {strategies.map((row) => (
            <tr
              key={row.asset.name}
              onClick={() => onRowClick(row.asset.name)}
              className="hover:bg-gray-800/40 cursor-pointer transition-colors"
            >
              <td className="px-4 py-3">
                <div>
                  <span className="text-white font-medium">{row.asset.name}</span>
                  <span className="text-gray-500 text-xs ml-2">{row.asset.displayName}</span>
                </div>
              </td>
              <td className="px-4 py-3 text-gray-400">{row.asset.chain}</td>
              <PctCell value={row.baseYield} positive />
              <PctCell value={row.bestBorrow?.borrowRate ?? null} />
              <td className="px-4 py-3 font-mono text-gray-300">
                {row.bestBorrow ? formatUsd(row.bestBorrow.liquidity) : "N/A"}
              </td>
              <td className="px-4 py-3 text-gray-300">
                {row.bestBorrow
                  ? `${row.bestBorrow.venue} (${row.bestBorrow.borrowAsset})`
                  : "N/A"}
              </td>
              <PctCell value={row.spread} positive />
              <PctCell value={row.net3x} positive />
              <PctCell value={row.net5x} positive />
            </tr>
          ))}
        </tbody>
      </table>
      {strategies.length === 0 && (
        <div className="text-center text-gray-500 py-12">No data available</div>
      )}
    </div>
  );
}
