"use client";

import type { ExitAnalysisResult } from "@/lib/backtester/types";

interface ExitSignalTableProps {
  result: ExitAnalysisResult;
}

export default function ExitSignalTable({ result }: ExitSignalTableProps) {
  return (
    <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-6">
      <h3 className="text-lg font-semibold text-gray-200 mb-1">
        Exit Signal Analysis
      </h3>
      <p className="text-sm text-gray-500 mb-4">
        Backtested trigger conditions against historical data (collateral APY:{" "}
        {(result.collateralApy * 100).toFixed(2)}%)
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-400 border-b border-gray-700">
              <th className="text-left py-2 px-3">Signal</th>
              <th className="text-left py-2 px-3">Description</th>
              <th className="text-right py-2 px-3">Times Triggered</th>
              <th className="text-right py-2 px-3">First Trigger</th>
              <th className="text-right py-2 px-3">Avg Return at Trigger</th>
              <th className="text-center py-2 px-3">Pre-Liquidation?</th>
            </tr>
          </thead>
          <tbody>
            {result.signals.map((signal) => (
              <tr
                key={signal.type}
                className="border-b border-gray-800 hover:bg-gray-700/30"
              >
                <td className="py-3 px-3">
                  <span
                    className={`font-medium ${
                      signal.triggerCount > 0
                        ? "text-amber-400"
                        : "text-gray-400"
                    }`}
                  >
                    {signal.label}
                  </span>
                </td>
                <td className="py-3 px-3 text-gray-400 text-xs max-w-xs">
                  {signal.description}
                </td>
                <td className="py-3 px-3 text-right">
                  <span
                    className={
                      signal.triggerCount > 0
                        ? "text-amber-300 font-semibold"
                        : "text-gray-500"
                    }
                  >
                    {signal.triggerCount > 0
                      ? `${signal.triggerCount} hours`
                      : "Never"}
                  </span>
                </td>
                <td className="py-3 px-3 text-right text-gray-300">
                  {signal.triggerTimestamps.length > 0
                    ? new Date(
                        signal.triggerTimestamps[0] * 1000
                      ).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })
                    : "-"}
                </td>
                <td className="py-3 px-3 text-right">
                  {signal.triggerCount > 0 ? (
                    <span
                      className={
                        signal.avgReturnAtTrigger >= 0
                          ? "text-emerald-400"
                          : "text-red-400"
                      }
                    >
                      {(signal.avgReturnAtTrigger * 100).toFixed(2)}%
                    </span>
                  ) : (
                    <span className="text-gray-500">-</span>
                  )}
                </td>
                <td className="py-3 px-3 text-center">
                  {signal.wouldHaveExited ? (
                    <span className="text-emerald-400 font-medium">
                      Yes
                    </span>
                  ) : signal.triggerCount > 0 ? (
                    <span className="text-gray-400">No liq.</span>
                  ) : (
                    <span className="text-gray-600">-</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div className="mt-3 text-xs text-gray-500">
        <strong>Pre-Liquidation?</strong> = Would this signal have triggered
        before a liquidation event, giving time to exit safely.
      </div>
    </div>
  );
}
