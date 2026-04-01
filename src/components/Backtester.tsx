"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useBacktest } from "@/hooks/useBacktest";
import { MORPHO_COLLATERAL_ADDRESSES } from "@/lib/constants";
import type { MorphoMarket } from "@/lib/types";
import ParameterInputs from "./backtest/ParameterInputs";
import OracleDeviation from "./backtest/OracleDeviation";
import BorrowRateHistory from "./backtest/BorrowRateHistory";
import MarginForError from "./backtest/MarginForError";
import EquityChart from "./backtest/EquityChart";
import HealthFactorChart from "./backtest/HealthFactorChart";
import OptimizationHeatmap from "./backtest/OptimizationHeatmap";
import CapacityCurve from "./backtest/CapacityCurve";
import ExitSignalTable from "./backtest/ExitSignalTable";

// ── Market configurations ───────────────────────────────────────────

const MARKET_OPTIONS = [
  {
    label: "sUSDS / USDT (Morpho)",
    collateralAsset: "sUSDS",
    borrowAsset: "USDT",
    vaultAddress: MORPHO_COLLATERAL_ADDRESSES.sUSDS,
  },
  {
    label: "sUSDS / USDC (Morpho)",
    collateralAsset: "sUSDS",
    borrowAsset: "USDC",
    vaultAddress: MORPHO_COLLATERAL_ADDRESSES.sUSDS,
  },
  {
    label: "sUSDE / USDT (Morpho)",
    collateralAsset: "sUSDE",
    borrowAsset: "USDT",
    vaultAddress: MORPHO_COLLATERAL_ADDRESSES.sUSDE,
  },
  {
    label: "sUSDE / USDC (Morpho)",
    collateralAsset: "sUSDE",
    borrowAsset: "USDC",
    vaultAddress: MORPHO_COLLATERAL_ADDRESSES.sUSDE,
  },
];

interface BacktesterProps {
  morphoMarkets: MorphoMarket[];
}

export default function Backtester({ morphoMarkets }: BacktesterProps) {
  const [selectedMarketIdx, setSelectedMarketIdx] = useState(0);

  // Strategy params state (persisted for Margin for Error)
  const [params, setParams] = useState({
    startingCapital: 100000,
    ltv: 0.77,
    leverage: 3.0,
  });

  const selectedOption = MARKET_OPTIONS[selectedMarketIdx];

  // Resolve market — pick highest liquidity
  const resolvedMarket = morphoMarkets
    .filter(
      (m) =>
        m.collateralAsset.address.toLowerCase() === selectedOption.vaultAddress.toLowerCase() &&
        m.loanAsset.symbol.toUpperCase() === selectedOption.borrowAsset.toUpperCase()
    )
    .sort((a, b) => (b.state.liquidityAssetsUsd ?? 0) - (a.state.liquidityAssetsUsd ?? 0))[0] ?? null;

  const marketUniqueKey = resolvedMarket?.uniqueKey ?? "";
  const liquidationLtv = resolvedMarket ? Number(resolvedMarket.lltv) / 1e18 : 0.86;

  const {
    data, isLoadingData, dataError, loadProgress, loadData, setMarketState,
    backtestResult, runSingleBacktest,
    optimizationResult, isOptimizing, runOptimize,
    capacityResult, exitAnalysis,
  } = useBacktest();

  // Pass real market state for capacity analysis
  useEffect(() => {
    if (resolvedMarket) {
      setMarketState({
        supplyAssetsUsd: resolvedMarket.state.supplyAssetsUsd ?? 50_000_000,
        borrowAssetsUsd: resolvedMarket.state.borrowAssetsUsd ?? 30_000_000,
        apyAtTarget: resolvedMarket.state.apyAtTarget ?? 0.03,
      });
    }
  }, [resolvedMarket, setMarketState]);

  // Track pending params so we can auto-run when data loads
  const pendingParams = useRef<{
    startingCapital: number; ltv: number; leverage: number;
    liquidationLtv: number; startTimestamp: number; endTimestamp: number;
  } | null>(null);

  const handleRun = useCallback(
    (p: {
      startingCapital: number; ltv: number; leverage: number;
      liquidationLtv: number; startTimestamp: number; endTimestamp: number;
    }) => {
      setParams({ startingCapital: p.startingCapital, ltv: p.ltv, leverage: p.leverage });

      // If data is loaded, run immediately
      if (data && data.length > 0) {
        runSingleBacktest({
          marketUniqueKey,
          collateralAsset: selectedOption.collateralAsset,
          borrowAsset: selectedOption.borrowAsset,
          ...p,
        });
        pendingParams.current = null;
      } else {
        // Data not loaded yet — trigger load and save params for auto-run
        pendingParams.current = p;
        loadData({
          marketUniqueKey,
          vaultAddress: selectedOption.vaultAddress,
          startTimestamp: p.startTimestamp,
          endTimestamp: p.endTimestamp,
        });
      }
    },
    [data, marketUniqueKey, selectedOption, runSingleBacktest, loadData]
  );

  // Auto-run when data finishes loading
  useEffect(() => {
    if (data && data.length > 0 && pendingParams.current) {
      const p = pendingParams.current;
      pendingParams.current = null;
      runSingleBacktest({
        marketUniqueKey,
        collateralAsset: selectedOption.collateralAsset,
        borrowAsset: selectedOption.borrowAsset,
        ...p,
      });
    }
  }, [data, marketUniqueKey, selectedOption, runSingleBacktest]);

  return (
    <div className="space-y-6">
      {/* Market Selector */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-6">
        <h2 className="text-xl font-bold text-gray-100 mb-2">Strategy Backtester</h2>
        <p className="text-sm text-gray-400 mb-4">
          Simulate historical performance of looping strategies with oracle-accurate pricing
        </p>

        <div className="flex items-center gap-4 flex-wrap">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Market</label>
            <select
              value={selectedMarketIdx}
              onChange={(e) => setSelectedMarketIdx(Number(e.target.value))}
              className="bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm min-w-[250px]"
            >
              {MARKET_OPTIONS.map((opt, i) => (
                <option key={i} value={i}>{opt.label}</option>
              ))}
            </select>
          </div>

          {resolvedMarket && (
            <div className="flex gap-4 text-sm text-gray-400 pt-5">
              <span>LLTV: <span className="text-gray-200">{(liquidationLtv * 100).toFixed(1)}%</span></span>
              <span>Current Borrow APY: <span className="text-gray-200">
                {resolvedMarket.state.borrowApy !== null
                  ? `${(resolvedMarket.state.borrowApy * 100).toFixed(2)}%`
                  : "N/A"}
              </span></span>
              <span>Liquidity: <span className="text-gray-200">
                ${(resolvedMarket.state.liquidityAssetsUsd ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </span></span>
            </div>
          )}
        </div>

        {!marketUniqueKey && (
          <div className="mt-3 text-sm text-amber-400">
            Market not found in Morpho data. Make sure the dashboard has loaded.
          </div>
        )}
      </div>

      {/* ── Section 1: Oracle Deviation & Borrow Rate (shown after data loads) ── */}
      {data && data.length > 0 && (
        <>
          <OracleDeviation data={data} />
          <BorrowRateHistory data={data} />
        </>
      )}

      {/* ── Section 2: Strategy Parameters ── */}
      {marketUniqueKey && (
        <ParameterInputs
          onRun={handleRun}
          liquidationLtv={liquidationLtv}
          isLoading={isLoadingData}
          dataRange={data && data.length > 0 ? { start: data[0].timestamp, end: data[data.length - 1].timestamp } : undefined}
        />
      )}

      {/* ── Section 3: Margin for Error (shown after data loads + params set) ── */}
      {data && data.length > 0 && (
        <MarginForError
          data={data}
          ltv={params.ltv}
          leverage={params.leverage}
          startingCapital={params.startingCapital}
          liquidationLtv={liquidationLtv}
        />
      )}

      {/* Loading State */}
      {isLoadingData && (
        <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-12 text-center">
          <div className="text-lg text-gray-300 mb-3">
            {loadProgress?.message ?? "Loading historical data..."}
          </div>
          {loadProgress && (
            <div className="w-full max-w-md mx-auto">
              <div className="bg-gray-700 rounded-full h-2 overflow-hidden">
                <div
                  className="bg-amber-500 h-full rounded-full transition-all duration-500"
                  style={{ width: `${loadProgress.percent}%` }}
                />
              </div>
              <div className="text-xs text-gray-500 mt-2">
                {loadProgress.percent}% — {loadProgress.stage}
              </div>
            </div>
          )}
          {!loadProgress && (
            <div className="text-sm text-gray-500 animate-pulse">
              Initializing...
            </div>
          )}
        </div>
      )}

      {/* Error */}
      {dataError && (
        <div className="bg-red-900/20 border border-red-800 rounded-xl p-4 text-red-300">
          <strong>Error:</strong> {dataError}
        </div>
      )}

      {/* ── Section 4: Backtest Results ── */}
      {backtestResult && (
        <>
          <EquityChart result={backtestResult} />
          <HealthFactorChart result={backtestResult} />
        </>
      )}

      {/* Optimization */}
      {backtestResult && (
        <OptimizationHeatmap
          result={optimizationResult!}
          isOptimizing={isOptimizing}
          onRunOptimize={() =>
            runOptimize({
              marketUniqueKey,
              collateralAsset: selectedOption.collateralAsset,
              borrowAsset: selectedOption.borrowAsset,
              startingCapital: backtestResult.config.startingCapital,
              liquidationLtv,
              startTimestamp: backtestResult.config.startTimestamp,
              endTimestamp: backtestResult.config.endTimestamp,
            })
          }
        />
      )}

      {/* Capacity */}
      {capacityResult && <CapacityCurve result={capacityResult} />}

      {/* Exit Signals */}
      {exitAnalysis && <ExitSignalTable result={exitAnalysis} />}
    </div>
  );
}
