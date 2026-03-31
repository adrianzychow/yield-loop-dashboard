"use client";

import useSWR from "swr";
import { useState, useMemo, useCallback } from "react";
import type {
  BacktestConfig,
  BacktestResult,
  HourlyDataPoint,
  OptimizationResult,
  CapacityResult,
  ExitAnalysisResult,
} from "@/lib/backtester/types";
import { runBacktest } from "@/lib/backtester/engine";
import { runOptimization } from "@/lib/backtester/optimizer";
import { runCapacityAnalysis } from "@/lib/backtester/capacity";
import { analyzeExitSignals } from "@/lib/backtester/exitSignals";

interface UseBacktestOptions {
  marketUniqueKey: string;
  collateralAsset: string;
  borrowAsset: string;
  vaultAddress: string;
  startTimestamp: number;
  endTimestamp: number;
}

interface UseBacktestReturn {
  // Data state
  data: HourlyDataPoint[] | null;
  isLoadingData: boolean;
  dataError: string | null;
  // Backtest
  backtestResult: BacktestResult | null;
  runSingleBacktest: (config: BacktestConfig) => void;
  // Optimization
  optimizationResult: OptimizationResult | null;
  isOptimizing: boolean;
  runOptimize: (config: Omit<BacktestConfig, "ltv" | "leverage">) => void;
  // Capacity
  capacityResult: CapacityResult | null;
  // Exit signals
  exitAnalysis: ExitAnalysisResult | null;
}

/**
 * Fetcher for backtest historical data via API route.
 */
async function fetchData(
  _key: string,
  options: UseBacktestOptions
): Promise<HourlyDataPoint[]> {
  const res = await fetch("/api/backtest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      marketUniqueKey: options.marketUniqueKey,
      collateralAsset: options.collateralAsset,
      borrowAsset: options.borrowAsset,
      vaultAddress: options.vaultAddress,
      startTimestamp: options.startTimestamp,
      endTimestamp: options.endTimestamp,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Network error" }));
    throw new Error(err.error || "Failed to fetch backtest data");
  }

  const json = await res.json();
  return json.data as HourlyDataPoint[];
}

export function useBacktest(
  options: UseBacktestOptions | null
): UseBacktestReturn {
  const [backtestResult, setBacktestResult] = useState<BacktestResult | null>(
    null
  );
  const [optimizationResult, setOptimizationResult] =
    useState<OptimizationResult | null>(null);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [capacityResult, setCapacityResult] = useState<CapacityResult | null>(
    null
  );
  const [exitAnalysis, setExitAnalysis] = useState<ExitAnalysisResult | null>(
    null
  );

  // Fetch historical data via SWR
  const swrKey = options
    ? `backtest-${options.marketUniqueKey}-${options.startTimestamp}-${options.endTimestamp}`
    : null;

  const {
    data,
    error,
    isLoading: isLoadingData,
  } = useSWR(
    swrKey ? [swrKey, options] : null,
    ([key, opts]) => fetchData(key, opts as UseBacktestOptions),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: 60000,
    }
  );

  // Run single backtest
  const runSingleBacktest = useCallback(
    (config: BacktestConfig) => {
      if (!data || data.length === 0) return;

      const result = runBacktest(config, data);
      setBacktestResult(result);

      // Also run exit signal analysis
      // Estimate collateral APY from oracle price appreciation
      const first = data[0];
      const last = data[data.length - 1];
      const hoursElapsed = data.length;
      const priceReturn =
        (last.oraclePrice - first.oraclePrice) / first.oraclePrice;
      const collateralApy =
        hoursElapsed > 0
          ? Math.pow(1 + priceReturn, 8760 / hoursElapsed) - 1
          : 0;

      const exits = analyzeExitSignals(
        result.snapshots,
        collateralApy,
        config.liquidationLtv
      );
      setExitAnalysis(exits);
    },
    [data]
  );

  // Run optimization
  const runOptimize = useCallback(
    (config: Omit<BacktestConfig, "ltv" | "leverage">) => {
      if (!data || data.length === 0) return;

      setIsOptimizing(true);

      // Run in a timeout to not block the UI
      setTimeout(() => {
        const result = runOptimization(config, data);
        setOptimizationResult(result);
        setIsOptimizing(false);
      }, 0);
    },
    [data]
  );

  // Compute capacity when backtest result is available
  useMemo(() => {
    if (!backtestResult || !data || data.length === 0) return;

    // Estimate collateral APY
    const first = data[0];
    const last = data[data.length - 1];
    const hoursElapsed = data.length;
    const priceReturn =
      (last.oraclePrice - first.oraclePrice) / first.oraclePrice;
    const collateralApy =
      hoursElapsed > 0
        ? Math.pow(1 + priceReturn, 8760 / hoursElapsed) - 1
        : 0;

    // Use average borrow APY to estimate apyAtTarget
    // (rough approximation — ideally fetched from Morpho)
    const cap = runCapacityAnalysis(
      {
        ...backtestResult.config,
        currentSupplyUsd: 50_000_000, // placeholder — should be fetched
        currentBorrowUsd: 30_000_000, // placeholder
        apyAtTarget: backtestResult.avgBorrowApy,
      },
      collateralApy
    );
    setCapacityResult(cap);
  }, [backtestResult, data]);

  return {
    data: data ?? null,
    isLoadingData,
    dataError: error ? (error as Error).message : null,
    backtestResult,
    runSingleBacktest,
    optimizationResult,
    isOptimizing,
    runOptimize,
    capacityResult,
    exitAnalysis,
  };
}
