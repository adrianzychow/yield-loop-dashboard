"use client";

import { useState, useEffect } from "react";

interface ParameterInputsProps {
  onRun: (params: {
    startingCapital: number;
    ltv: number;
    leverage: number;
    liquidationLtv: number;
    startTimestamp: number;
    endTimestamp: number;
  }) => void;
  liquidationLtv: number;
  isLoading: boolean;
  dataRange?: { start: number; end: number };
}

export default function ParameterInputs({
  onRun,
  liquidationLtv,
  isLoading,
  dataRange,
}: ParameterInputsProps) {
  const [startingCapital, setStartingCapital] = useState(100000);
  const [ltv, setLtv] = useState(0.77);
  const [leverage, setLeverage] = useState(3.0);
  const [daysBack, setDaysBack] = useState(90);

  // Max leverage for the current LTV
  const maxLeverage = 1 / (1 - ltv);

  // Clamp leverage when LTV changes
  useEffect(() => {
    if (leverage > maxLeverage) {
      setLeverage(Math.floor(maxLeverage * 10) / 10);
    }
  }, [ltv, maxLeverage, leverage]);

  const handleRun = () => {
    const now = Math.floor(Date.now() / 1000);
    const start = dataRange
      ? Math.max(dataRange.start, now - daysBack * 86400)
      : now - daysBack * 86400;
    const end = dataRange ? Math.min(dataRange.end, now) : now;

    onRun({
      startingCapital,
      ltv,
      leverage,
      liquidationLtv,
      startTimestamp: start,
      endTimestamp: end,
    });
  };

  return (
    <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-6 mb-6">
      <h3 className="text-lg font-semibold text-gray-200 mb-4">
        Strategy Parameters
      </h3>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        {/* Starting Capital */}
        <div>
          <label className="block text-sm text-gray-400 mb-1">
            Starting Capital
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">
              $
            </span>
            <input
              type="number"
              value={startingCapital}
              onChange={(e) =>
                setStartingCapital(Math.max(1000, Number(e.target.value)))
              }
              className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 pl-7 text-white text-sm"
            />
          </div>
        </div>

        {/* LTV */}
        <div>
          <label className="block text-sm text-gray-400 mb-1">
            LTV: {(ltv * 100).toFixed(1)}%
          </label>
          <input
            type="range"
            min={0.3}
            max={liquidationLtv - 0.01}
            step={0.005}
            value={ltv}
            onChange={(e) => setLtv(Number(e.target.value))}
            className="w-full accent-amber-500"
          />
          <div className="flex justify-between text-xs text-gray-500 mt-1">
            <span>30%</span>
            <span>LLTV: {(liquidationLtv * 100).toFixed(0)}%</span>
          </div>
        </div>

        {/* Leverage */}
        <div>
          <label className="block text-sm text-gray-400 mb-1">
            Leverage: {leverage.toFixed(1)}x
          </label>
          <input
            type="range"
            min={1.1}
            max={Math.min(maxLeverage - 0.1, 10)}
            step={0.1}
            value={leverage}
            onChange={(e) => setLeverage(Number(e.target.value))}
            className="w-full accent-amber-500"
          />
          <div className="flex justify-between text-xs text-gray-500 mt-1">
            <span>1.1x</span>
            <span>Max: {maxLeverage.toFixed(1)}x</span>
          </div>
        </div>

        {/* Backtest Period */}
        <div>
          <label className="block text-sm text-gray-400 mb-1">
            Period
          </label>
          <div className="flex gap-1">
            {[30, 60, 90].map((d) => (
              <button
                key={d}
                onClick={() => setDaysBack(d)}
                className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
                  daysBack === d
                    ? "bg-amber-600 text-white"
                    : "bg-gray-700 text-gray-400 hover:bg-gray-600"
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Derived Info */}
      <div className="flex items-center justify-between">
        <div className="flex gap-6 text-sm text-gray-400">
          <span>
            Total Assets:{" "}
            <span className="text-gray-200">
              ${(startingCapital * leverage).toLocaleString()}
            </span>
          </span>
          <span>
            Debt:{" "}
            <span className="text-gray-200">
              ${(startingCapital * (leverage - 1)).toLocaleString()}
            </span>
          </span>
          <span>
            Health Factor Buffer:{" "}
            <span
              className={
                liquidationLtv / ltv > 1.2
                  ? "text-emerald-400"
                  : liquidationLtv / ltv > 1.1
                    ? "text-amber-400"
                    : "text-red-400"
              }
            >
              {((liquidationLtv / ltv - 1) * 100).toFixed(1)}% above
              liquidation
            </span>
          </span>
        </div>

        <button
          onClick={handleRun}
          disabled={isLoading}
          className="bg-amber-600 hover:bg-amber-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white px-6 py-2.5 rounded-lg font-semibold transition-colors"
        >
          {isLoading ? "Loading Data..." : "Run Backtest"}
        </button>
      </div>
    </div>
  );
}
