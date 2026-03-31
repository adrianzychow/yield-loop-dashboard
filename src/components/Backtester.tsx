"use client";

import { useState, useCallback } from "react";
import { useBacktest } from "@/hooks/useBacktest";
import { MORPHO_COLLATERAL_ADDRESSES } from "@/lib/constants";
import type { MorphoMarket } from "@/lib/types";
import ParameterInputs from "./backtest/ParameterInputs";
import EquityChart from "./backtest/EquityChart";
import HealthFactorChart from "./backtest/HealthFactorChart";
import OptimizationHeatmap from "./backtest/OptimizationHeatmap";
import CapacityCurve from "./backtest/CapacityCurve";
import ExitSignalTable from "./backtest/ExitSignalTable";

// ── Market configurations for backtesting ───────────────────────────

interface MarketOption {
  label: string;
  collateralAsset: string;
  borrowAsset: string;
  vaultAddress: string;
  marketUniqueKey: string; // Will be resolved from morphoMarkets
}

const MARKET_OPTIONS: Omit<MarketOption, "marketUniqueKey">[] = [
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
  const [backtestDays, setBacktestDays] = useState(90);
  const [hasStarted, setHasStarted] = useState(false);

  const selectedOption = MARKET_OPTIONS[selectedMarketIdx];

  // Resolve market unique key from morphoMarkets — pick highest liquidity match
  const resolvedMarket = morphoMarkets
    .filter(
      (m) =>
        m.collateralAsset.address.toLowerCase() ===
          selectedOption.vaultAddress.toLowerCase() &&
        m.loanAsset.symbol.toUpperCase() ===
          selectedOption.borrowAsset.toUpperCase()
    )
    .sort(
      (a, b) =>
        (b.state.liquidityAssetsUsd ?? 0) - (a.state.liquidityAssetsUsd ?? 0)
    )[0] ?? null;

  const marketUniqueKey = resolvedMarket?.uniqueKey ?? "";
  const liquidationLtv = resolvedMarket
    ? Number(resolvedMarket.lltv) / 1e18
    : 0.86;

  // Time range
  const now = Math.floor(Date.now() / 1000);
  const startTimestamp = now - backtestDays * 86400;

  // Use backtest hook — only fetch when user clicks run
  const {
    data,
    isLoadingData,
    dataError,
    backtestResult,
    runSingleBacktest,
    optimizationResult,
    isOptimizing,
    runOptimize,
    capacityResult,
    exitAnalysis,
  } = useBacktest(
    hasStarted && marketUniqueKey
      ? {
          marketUniqueKey,
          collateralAsset: selectedOption.collateralAsset,
          borrowAsset: selectedOption.borrowAsset,
          vaultAddress: selectedOption.vaultAddress,
          startTimestamp,
          endTimestamp: now,
        }
      : null
  );

  const handleRun = useCallback(
    (params: {
      startingCapital: number;
      ltv: number;
      leverage: number;
      liquidationLtv: number;
      startTimestamp: number;
      endTimestamp: number;
    }) => {
      setBacktestDays(
        Math.round((params.endTimestamp - params.startTimestamp) / 86400)
      );
      setHasStarted(true);

      // If data is already loaded, run immediately
      if (data && data.length > 0) {
        runSingleBacktest({
          marketUniqueKey,
          collateralAsset: selectedOption.collateralAsset,
          borrowAsset: selectedOption.borrowAsset,
          startingCapital: params.startingCapital,
          ltv: params.ltv,
          leverage: params.leverage,
          liquidationLtv: params.liquidationLtv,
          startTimestamp: params.startTimestamp,
          endTimestamp: params.endTimestamp,
        });
      }
    },
    [data, marketUniqueKey, selectedOption, runSingleBacktest]
  );

  // Auto-run backtest when data loads
  const handleRunAfterDataLoad = useCallback(() => {
    if (data && data.length > 0 && hasStarted && !backtestResult) {
      // Use default parameters for initial run
      runSingleBacktest({
        marketUniqueKey,
        collateralAsset: selectedOption.collateralAsset,
        borrowAsset: selectedOption.borrowAsset,
        startingCapital: 100000,
        ltv: 0.77,
        leverage: 3.0,
        liquidationLtv,
        startTimestamp,
        endTimestamp: now,
      });
    }
  }, [
    data,
    hasStarted,
    backtestResult,
    marketUniqueKey,
    selectedOption,
    liquidationLtv,
    startTimestamp,
    now,
    runSingleBacktest,
  ]);

  // Trigger auto-run
  if (data && data.length > 0 && hasStarted && !backtestResult) {
    handleRunAfterDataLoad();
  }

  return (
    <div className="space-y-6">
      {/* Market Selector */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-6">
        <h2 className="text-xl font-bold text-gray-100 mb-2">
          Strategy Backtester
        </h2>
        <p className="text-sm text-gray-400 mb-4">
          Simulate historical performance of looping strategies with
          oracle-accurate pricing
        </p>

        <div className="flex items-center gap-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Market</label>
            <select
              value={selectedMarketIdx}
              onChange={(e) => {
                setSelectedMarketIdx(Number(e.target.value));
                setHasStarted(false);
              }}
              className="bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm min-w-[250px]"
            >
              {MARKET_OPTIONS.map((opt, i) => (
                <option key={i} value={i}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {resolvedMarket && (
            <div className="flex gap-4 text-sm text-gray-400 pt-5">
              <span>
                LLTV:{" "}
                <span className="text-gray-200">
                  {(liquidationLtv * 100).toFixed(1)}%
                </span>
              </span>
              <span>
                Current Borrow APY:{" "}
                <span className="text-gray-200">
                  {resolvedMarket.state.borrowApy !== null
                    ? `${(resolvedMarket.state.borrowApy * 100).toFixed(2)}% ${resolvedMarket.state.borrowApy > 1 ? "(illiquid)" : ""}`
                    : "N/A"}
                </span>
              </span>
              <span>
                Liquidity:{" "}
                <span className="text-gray-200">
                  $
                  {(
                    resolvedMarket.state.liquidityAssetsUsd ?? 0
                  ).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
              </span>
            </div>
          )}
        </div>

        {!marketUniqueKey && (
          <div className="mt-3 text-sm text-amber-400">
            Market not found in Morpho data. Make sure the dashboard has loaded.
          </div>
        )}
      </div>

      {/* Parameter Inputs */}
      {marketUniqueKey && (
        <ParameterInputs
          onRun={handleRun}
          liquidationLtv={liquidationLtv}
          isLoading={isLoadingData}
          dataRange={
            data && data.length > 0
              ? {
                  start: data[0].timestamp,
                  end: data[data.length - 1].timestamp,
                }
              : undefined
          }
        />
      )}

      {/* Loading State */}
      {isLoadingData && (
        <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-12 text-center">
          <div className="animate-pulse">
            <div className="text-lg text-gray-300 mb-2">
              Loading historical data...
            </div>
            <div className="text-sm text-gray-500">
              Fetching exchange rates from archive node, prices from CoinGecko,
              and borrow rates from Morpho
            </div>
            <div className="text-xs text-gray-600 mt-2">
              This may take 30-60 seconds for the first load
            </div>
          </div>
        </div>
      )}

      {/* Error */}
      {dataError && (
        <div className="bg-red-900/20 border border-red-800 rounded-xl p-4 text-red-300">
          <strong>Error:</strong> {dataError}
        </div>
      )}

      {/* Data loaded indicator */}
      {data && data.length > 0 && !backtestResult && (
        <div className="bg-gray-800/50 border border-gray-700 rounded-xl p-4 text-center text-gray-400">
          {data.length.toLocaleString()} hourly data points loaded (
          {new Date(data[0].timestamp * 1000).toLocaleDateString()} →{" "}
          {new Date(
            data[data.length - 1].timestamp * 1000
          ).toLocaleDateString()}
          ). Adjust parameters above and click &quot;Run Backtest&quot;.
        </div>
      )}

      {/* Results */}
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
