"use client";

import { useState, useMemo, useCallback, useRef } from "react";
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
import { loadWstEthBacktestDataClient } from "@/lib/backtester/wstethDataLoader";

interface UseBacktestReturn {
  data: HourlyDataPoint[] | null;
  isLoadingData: boolean;
  dataError: string | null;
  loadProgress: LoadProgress | null;
  // Imperative load trigger
  loadData: (opts: {
    marketUniqueKey: string;
    vaultAddress: string;
    startTimestamp: number;
    endTimestamp: number;
    loaderType?: "stablecoin" | "wsteth";
  }) => void;
  setMarketState: (state: {
    supplyAssetsUsd: number;
    borrowAssetsUsd: number;
    apyAtTarget: number;
  }) => void;
  backtestResult: BacktestResult | null;
  runSingleBacktest: (config: BacktestConfig) => void;
  optimizationResult: OptimizationResult | null;
  isOptimizing: boolean;
  runOptimize: (config: Omit<BacktestConfig, "ltv" | "leverage">) => void;
  capacityResult: CapacityResult | null;
  exitAnalysis: ExitAnalysisResult | null;
}

export function useBacktest(): UseBacktestReturn {
  const [data, setData] = useState<HourlyDataPoint[] | null>(null);
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [loadProgress, setLoadProgress] = useState<LoadProgress | null>(null);

  const [backtestResult, setBacktestResult] = useState<BacktestResult | null>(null);
  const [optimizationResult, setOptimizationResult] = useState<OptimizationResult | null>(null);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [capacityResult, setCapacityResult] = useState<CapacityResult | null>(null);
  const [exitAnalysis, setExitAnalysis] = useState<ExitAnalysisResult | null>(null);

  // Market state for capacity analysis (set by parent component from resolved Morpho market)
  const marketStateRef = useRef<{
    supplyAssetsUsd: number;
    borrowAssetsUsd: number;
    apyAtTarget: number;
  } | null>(null);

  const setMarketState = useCallback((state: {
    supplyAssetsUsd: number;
    borrowAssetsUsd: number;
    apyAtTarget: number;
  }) => {
    marketStateRef.current = state;
  }, []);

  const loadedKeyRef = useRef<string | null>(null);
  const loadingRef = useRef(false);

  // Imperative data loader — no useEffect, no StrictMode issues
  const loadData = useCallback((opts: {
    marketUniqueKey: string;
    vaultAddress: string;
    startTimestamp: number;
    endTimestamp: number;
    loaderType?: "stablecoin" | "wsteth";
  }) => {
    const rpcUrl = process.env.NEXT_PUBLIC_ETH_RPC_URL;
    if (!rpcUrl) {
      setDataError("NEXT_PUBLIC_ETH_RPC_URL not configured");
      return;
    }

    const loadKey = `${opts.loaderType ?? "stablecoin"}-${opts.marketUniqueKey}-${opts.startTimestamp}-${opts.endTimestamp}`;

    // Skip if already loaded or currently loading
    if (loadedKeyRef.current === loadKey || loadingRef.current) {
      return;
    }

    loadingRef.current = true;
    setIsLoadingData(true);
    setDataError(null);
    setLoadProgress({ stage: "blocks", message: "Starting...", percent: 0 });

    const loadPromise =
      opts.loaderType === "wsteth"
        ? loadWstEthBacktestDataClient(
            rpcUrl,
            opts.marketUniqueKey,
            opts.startTimestamp,
            opts.endTimestamp,
            (progress) => setLoadProgress(progress)
          )
        : loadBacktestDataClient(
            rpcUrl,
            opts.marketUniqueKey,
            opts.vaultAddress,
            opts.startTimestamp,
            opts.endTimestamp,
            (progress) => setLoadProgress(progress)
          );

    loadPromise
      .then((result) => {
        setData(result);
        setIsLoadingData(false);
        setLoadProgress(null);
        loadedKeyRef.current = loadKey;
        loadingRef.current = false;
      })
      .catch((err) => {
        setDataError(err instanceof Error ? err.message : "Failed to load data");
        setIsLoadingData(false);
        setLoadProgress(null);
        loadingRef.current = false;
      });
  }, []);

  // Run single backtest
  const runSingleBacktest = useCallback(
    (config: BacktestConfig) => {
      if (!data || data.length === 0) return;

      const result = runBacktest(config, data);
      setBacktestResult(result);

      const first = data[0];
      const last = data[data.length - 1];
      const actualHoursElapsed = (last.timestamp - first.timestamp) / 3600;
      const priceReturn = (last.oraclePrice - first.oraclePrice) / first.oraclePrice;
      const collateralApy =
        actualHoursElapsed > 0
          ? Math.pow(1 + priceReturn, 8760 / actualHoursElapsed) - 1
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
    const actualHoursElapsed = (last.timestamp - first.timestamp) / 3600;
    const priceReturn = (last.oraclePrice - first.oraclePrice) / first.oraclePrice;
    const collateralApy =
      actualHoursElapsed > 0
        ? Math.pow(1 + priceReturn, 8760 / actualHoursElapsed) - 1
        : 0;

    // Use real market data if available, otherwise fall back to backtest avg
    const mkt = marketStateRef.current;
    const cap = runCapacityAnalysis(
      {
        ...backtestResult.config,
        currentSupplyUsd: mkt?.supplyAssetsUsd ?? 50_000_000,
        currentBorrowUsd: mkt?.borrowAssetsUsd ?? 30_000_000,
        apyAtTarget: mkt?.apyAtTarget ?? backtestResult.avgBorrowApy,
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
    loadData,
    setMarketState,
    backtestResult,
    runSingleBacktest,
    optimizationResult,
    isOptimizing,
    runOptimize,
    capacityResult,
    exitAnalysis,
  };
}
