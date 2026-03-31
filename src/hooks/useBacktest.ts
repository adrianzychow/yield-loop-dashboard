"use client";

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
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
import { loadBacktestDataClient, type LoadProgress } from "@/lib/backtester/dataLoader";

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
  loadProgress: LoadProgress | null;
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

export function useBacktest(
  options: UseBacktestOptions | null
): UseBacktestReturn {
  const [data, setData] = useState<HourlyDataPoint[] | null>(null);
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [loadProgress, setLoadProgress] = useState<LoadProgress | null>(null);

  const [backtestResult, setBacktestResult] = useState<BacktestResult | null>(null);
  const [optimizationResult, setOptimizationResult] = useState<OptimizationResult | null>(null);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [capacityResult, setCapacityResult] = useState<CapacityResult | null>(null);
  const [exitAnalysis, setExitAnalysis] = useState<ExitAnalysisResult | null>(null);

  // Track current load to avoid duplicate fetches
  const loadKeyRef = useRef<string | null>(null);

  // Load data client-side when options change
  useEffect(() => {
    if (!options) {
      setData(null);
      setDataError(null);
      setLoadProgress(null);
      return;
    }

    const rpcUrl = process.env.NEXT_PUBLIC_ETH_RPC_URL;
    if (!rpcUrl) {
      setDataError("NEXT_PUBLIC_ETH_RPC_URL not configured");
      return;
    }

    const loadKey = `${options.marketUniqueKey}-${options.startTimestamp}-${options.endTimestamp}`;
    if (loadKeyRef.current === loadKey && data && data.length > 0) {
      return; // Already loaded this exact data
    }

    let cancelled = false;
    loadKeyRef.current = loadKey;

    const doLoad = async () => {
      setIsLoadingData(true);
      setDataError(null);
      setLoadProgress({ stage: "blocks", message: "Starting...", percent: 0 });

      try {
        const result = await loadBacktestDataClient(
          rpcUrl,
          options.marketUniqueKey,
          options.vaultAddress,
          options.startTimestamp,
          options.endTimestamp,
          (progress) => {
            if (!cancelled) setLoadProgress(progress);
          }
        );

        if (!cancelled) {
          setData(result);
          setIsLoadingData(false);
          setLoadProgress(null);
        }
      } catch (err) {
        if (!cancelled) {
          setDataError(err instanceof Error ? err.message : "Failed to load data");
          setIsLoadingData(false);
          setLoadProgress(null);
        }
      }
    };

    doLoad();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options?.marketUniqueKey, options?.startTimestamp, options?.endTimestamp, options?.vaultAddress]);

  // Run single backtest
  const runSingleBacktest = useCallback(
    (config: BacktestConfig) => {
      if (!data || data.length === 0) return;

      const result = runBacktest(config, data);
      setBacktestResult(result);

      // Also run exit signal analysis
      const first = data[0];
      const last = data[data.length - 1];
      const hoursElapsed = data.length;
      const priceReturn = (last.oraclePrice - first.oraclePrice) / first.oraclePrice;
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

    const first = data[0];
    const last = data[data.length - 1];
    const hoursElapsed = data.length;
    const priceReturn = (last.oraclePrice - first.oraclePrice) / first.oraclePrice;
    const collateralApy =
      hoursElapsed > 0
        ? Math.pow(1 + priceReturn, 8760 / hoursElapsed) - 1
        : 0;

    const cap = runCapacityAnalysis(
      {
        ...backtestResult.config,
        currentSupplyUsd: 50_000_000,
        currentBorrowUsd: 30_000_000,
        apyAtTarget: backtestResult.avgBorrowApy,
      },
      collateralApy
    );
    setCapacityResult(cap);
  }, [backtestResult, data]);

  return {
    data,
    isLoadingData,
    dataError,
    loadProgress,
    backtestResult,
    runSingleBacktest,
    optimizationResult,
    isOptimizing,
    runOptimize,
    capacityResult,
    exitAnalysis,
  };
}
