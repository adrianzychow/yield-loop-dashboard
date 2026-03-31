"use client";

import type { OptimizationResult } from "@/lib/backtester/types";

interface OptimizationHeatmapProps {
  result: OptimizationResult;
  isOptimizing: boolean;
  onRunOptimize: () => void;
}

export default function OptimizationHeatmap({
  result,
  isOptimizing,
  onRunOptimize,
}: OptimizationHeatmapProps) {
  if (!result && !isOptimizing) {
    return (
      <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-6">
        <div className="flex justify-between items-center mb-4">
          <div>
            <h3 className="text-lg font-semibold text-gray-200">
              Parameter Optimization
            </h3>
            <p className="text-sm text-gray-500">
              Grid search over LTV and leverage to find optimal parameters
            </p>
          </div>
          <button
            onClick={onRunOptimize}
            className="bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          >
            Run Optimization
          </button>
        </div>
      </div>
    );
  }

  if (isOptimizing) {
    return (
      <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-6">
        <h3 className="text-lg font-semibold text-gray-200 mb-4">
          Parameter Optimization
        </h3>
        <div className="text-center py-8 text-gray-400 animate-pulse">
          Running grid search...
        </div>
      </div>
    );
  }

  if (!result) return null;

  // Build grid data for heatmap
  const ltvValues = [...new Set(result.points.map((p) => p.ltv))].sort();
  const leverageValues = [
    ...new Set(result.points.map((p) => p.leverage)),
  ].sort();

  // Create lookup
  const lookup = new Map<string, (typeof result.points)[0]>();
  for (const p of result.points) {
    lookup.set(`${p.ltv}-${p.leverage}`, p);
  }

  // Color scale for annualized return
  const getColor = (point: (typeof result.points)[0] | undefined) => {
    if (!point) return "bg-gray-900";
    if (point.liquidated) return "bg-red-900/60";

    const ret = point.annualizedReturn * 100;
    if (ret > 15) return "bg-emerald-600";
    if (ret > 10) return "bg-emerald-700";
    if (ret > 5) return "bg-emerald-800";
    if (ret > 2) return "bg-emerald-900";
    if (ret > 0) return "bg-gray-700";
    return "bg-red-900/40";
  };

  return (
    <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-6">
      <div className="flex justify-between items-start mb-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-200">
            Parameter Optimization
          </h3>
          <p className="text-sm text-gray-500">
            {result.points.length} combinations tested |{" "}
            {result.points.filter((p) => p.liquidated).length} liquidated
          </p>
        </div>
        <button
          onClick={onRunOptimize}
          className="bg-purple-600 hover:bg-purple-700 text-white px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
        >
          Re-run
        </button>
      </div>

      {/* Optimal parameters callout */}
      {result.optimal && (
        <div className="bg-emerald-900/30 border border-emerald-700 rounded-lg px-4 py-3 mb-4">
          <div className="text-sm font-medium text-emerald-300">
            Optimal Parameters (no liquidation, HF {">"} 1.05)
          </div>
          <div className="grid grid-cols-4 gap-4 mt-2 text-sm">
            <div>
              <span className="text-gray-400">LTV: </span>
              <span className="text-white font-semibold">
                {(result.optimal.ltv * 100).toFixed(1)}%
              </span>
            </div>
            <div>
              <span className="text-gray-400">Leverage: </span>
              <span className="text-white font-semibold">
                {result.optimal.leverage.toFixed(1)}x
              </span>
            </div>
            <div>
              <span className="text-gray-400">Return: </span>
              <span className="text-emerald-400 font-semibold">
                {(result.optimal.annualizedReturn * 100).toFixed(2)}%
              </span>
            </div>
            <div>
              <span className="text-gray-400">Min HF: </span>
              <span className="text-white font-semibold">
                {result.optimal.minHealthFactor.toFixed(3)}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Heatmap grid */}
      <div className="overflow-x-auto">
        <table className="text-xs">
          <thead>
            <tr>
              <th className="px-1 py-1 text-gray-500 text-left">
                LTV \ Lev
              </th>
              {leverageValues.map((lev) => (
                <th
                  key={lev}
                  className="px-1 py-1 text-gray-400 text-center min-w-[48px]"
                >
                  {lev.toFixed(1)}x
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ltvValues.map((ltv) => (
              <tr key={ltv}>
                <td className="px-1 py-1 text-gray-400 font-medium">
                  {(ltv * 100).toFixed(1)}%
                </td>
                {leverageValues.map((lev) => {
                  const point = lookup.get(`${ltv}-${lev}`);
                  const isOptimal =
                    result.optimal &&
                    result.optimal.ltv === ltv &&
                    result.optimal.leverage === lev;

                  return (
                    <td
                      key={lev}
                      className={`px-1 py-1 text-center rounded ${getColor(point)} ${
                        isOptimal ? "ring-2 ring-amber-400" : ""
                      }`}
                      title={
                        point
                          ? `LTV: ${(ltv * 100).toFixed(1)}%, Lev: ${lev.toFixed(1)}x\nReturn: ${(point.annualizedReturn * 100).toFixed(2)}%\nMin HF: ${point.minHealthFactor.toFixed(3)}\nDrawdown: ${(point.maxDrawdown * 100).toFixed(2)}%${point.liquidated ? "\nLIQUIDATED" : ""}`
                          : "N/A"
                      }
                    >
                      {point ? (
                        <span
                          className={
                            point.liquidated
                              ? "text-red-300"
                              : "text-gray-200"
                          }
                        >
                          {point.liquidated
                            ? "X"
                            : `${(point.annualizedReturn * 100).toFixed(1)}`}
                        </span>
                      ) : (
                        <span className="text-gray-600">-</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-4 mt-3 text-xs text-gray-500">
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 rounded bg-emerald-600 inline-block" />
          {">"}15%
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 rounded bg-emerald-800 inline-block" />
          5-15%
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 rounded bg-gray-700 inline-block" />
          0-5%
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 rounded bg-red-900/60 inline-block" />
          Liquidated
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 rounded bg-gray-700 ring-2 ring-amber-400 inline-block" />
          Optimal
        </span>
      </div>
    </div>
  );
}
