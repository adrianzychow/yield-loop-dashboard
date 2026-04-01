"use client";

import type { HourlyDataPoint } from "@/lib/backtester/types";

interface MarginForErrorProps {
  data: HourlyDataPoint[];
  ltv: number;
  leverage: number;
  startingCapital: number;
  liquidationLtv: number;
}

export default function MarginForError({
  data,
  ltv,
  leverage,
  startingCapital,
  liquidationLtv,
}: MarginForErrorProps) {
  if (data.length === 0) return null;

  const entryPrice = data[data.length - 1].oraclePrice; // use latest price as entry
  const totalAssets = startingCapital * leverage;
  const debt = totalAssets - startingCapital;
  const collateralUnits = totalAssets / entryPrice;

  // 1. Starting health factor
  const startingHF = debt > 0 ? (collateralUnits * entryPrice * liquidationLtv) / debt : Infinity;

  // 2. Liquidation price: HF = (units × price × LLTV) / debt = 1
  //    => price = debt / (units × LLTV)
  const liquidationPrice = debt > 0 ? debt / (collateralUnits * liquidationLtv) : 0;

  // 3. Max drawdown from historical oracle data
  let peak = data[0].oraclePrice;
  let maxDD = 0;
  let troughPrice = data[0].oraclePrice;
  for (const p of data) {
    if (p.oraclePrice > peak) peak = p.oraclePrice;
    const dd = (peak - p.oraclePrice) / peak;
    if (dd > maxDD) {
      maxDD = dd;
      troughPrice = p.oraclePrice;
    }
  }

  // Worst-case price: entry price × (1 - maxDrawdown)
  const worstCasePrice = entryPrice * (1 - maxDD);
  const worstCaseCollateralValue = collateralUnits * worstCasePrice;
  const worstCaseHF = debt > 0 ? (worstCaseCollateralValue * liquidationLtv) / debt : Infinity;

  // 4. Buffer %: how much further can price drop from entry until HF = 1
  //    HF = (units × price × LLTV) / debt = 1 when price = liquidationPrice
  //    Buffer = (entryPrice - liquidationPrice) / entryPrice
  const buffer = entryPrice > 0 ? (entryPrice - liquidationPrice) / entryPrice : 0;

  // Additional: buffer from worst case
  const worstCaseBuffer = worstCasePrice > 0 ? (worstCasePrice - liquidationPrice) / worstCasePrice : 0;

  const isHFDanger = (hf: number) => hf < 1.1;
  const isHFWarning = (hf: number) => hf < 1.3;
  const hfColor = (hf: number) =>
    isHFDanger(hf) ? "text-red-400" : isHFWarning(hf) ? "text-amber-400" : "text-emerald-400";

  return (
    <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-6">
      <h3 className="text-lg font-semibold text-gray-200 mb-1">
        Margin for Error
      </h3>
      <p className="text-sm text-gray-500 mb-4">
        Safety analysis based on {leverage.toFixed(1)}x leverage, {(ltv * 100).toFixed(1)}% LTV, LLTV {(liquidationLtv * 100).toFixed(1)}%
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-400 border-b border-gray-700">
              <th className="text-left py-2 px-3">Metric</th>
              <th className="text-right py-2 px-3">Value</th>
              <th className="text-left py-2 px-3 pl-6">Notes</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-gray-800">
              <td className="py-3 px-3 text-gray-300 font-medium">Starting Health Factor</td>
              <td className={`py-3 px-3 text-right font-semibold ${hfColor(startingHF)}`}>
                {startingHF === Infinity ? "N/A (no debt)" : startingHF.toFixed(4)}
              </td>
              <td className="py-3 px-3 pl-6 text-xs text-gray-500">
                (Collateral × LLTV) / Debt at entry price ${entryPrice.toFixed(4)}
              </td>
            </tr>
            <tr className="border-b border-gray-800">
              <td className="py-3 px-3 text-gray-300 font-medium">Liquidation Price</td>
              <td className="py-3 px-3 text-right font-semibold text-red-400">
                ${liquidationPrice.toFixed(4)}
              </td>
              <td className="py-3 px-3 pl-6 text-xs text-gray-500">
                Oracle price where HF = 1.0 (debt / (units × LLTV))
              </td>
            </tr>
            <tr className="border-b border-gray-800">
              <td className="py-3 px-3 text-gray-300 font-medium">Worst-Case Health Factor</td>
              <td className={`py-3 px-3 text-right font-semibold ${hfColor(worstCaseHF)}`}>
                {worstCaseHF === Infinity ? "N/A" : worstCaseHF.toFixed(4)}
              </td>
              <td className="py-3 px-3 pl-6 text-xs text-gray-500">
                HF if max historical drawdown ({(maxDD * 100).toFixed(2)}%) occurs from entry — price at ${worstCasePrice.toFixed(4)}
              </td>
            </tr>
            <tr className="border-b border-gray-800">
              <td className="py-3 px-3 text-gray-300 font-medium">Buffer to Liquidation</td>
              <td className={`py-3 px-3 text-right font-semibold ${buffer > 0.15 ? "text-emerald-400" : buffer > 0.05 ? "text-amber-400" : "text-red-400"}`}>
                {(buffer * 100).toFixed(2)}%
              </td>
              <td className="py-3 px-3 pl-6 text-xs text-gray-500">
                Price can drop {(buffer * 100).toFixed(2)}% from entry (${entryPrice.toFixed(4)} → ${liquidationPrice.toFixed(4)}) before liquidation
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Visual bar */}
      <div className="mt-4 pt-4 border-t border-gray-700">
        <div className="text-xs text-gray-500 mb-2">Price Range Visualization</div>
        <div className="relative h-8 bg-gray-900 rounded-lg overflow-hidden">
          {/* Liquidation zone */}
          <div
            className="absolute h-full bg-red-900/40"
            style={{ left: 0, width: `${Math.min(100, (1 - buffer) * 100)}%` }}
          />
          {/* Safe zone */}
          <div
            className="absolute h-full bg-emerald-900/30"
            style={{ left: `${Math.min(100, (1 - buffer) * 100)}%`, right: 0 }}
          />
          {/* Liquidation price marker */}
          <div
            className="absolute h-full w-0.5 bg-red-500"
            style={{ left: `${Math.max(0, Math.min(100, ((liquidationPrice / entryPrice) * 50)))}%` }}
          />
          {/* Entry price marker */}
          <div className="absolute h-full w-0.5 bg-emerald-400" style={{ right: "10%" }} />
          {/* Worst case marker */}
          {maxDD > 0 && (
            <div
              className="absolute h-full w-0.5 bg-amber-400"
              style={{ left: `${Math.max(0, Math.min(100, ((1 - maxDD) * 90)))}%` }}
            />
          )}
        </div>
        <div className="flex justify-between text-xs text-gray-600 mt-1">
          <span className="text-red-400">Liq: ${liquidationPrice.toFixed(4)}</span>
          {maxDD > 0 && <span className="text-amber-400">Worst: ${worstCasePrice.toFixed(4)}</span>}
          <span className="text-emerald-400">Entry: ${entryPrice.toFixed(4)}</span>
        </div>
      </div>
    </div>
  );
}
