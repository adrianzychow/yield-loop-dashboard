"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useBacktest } from "@/hooks/useBacktest";
import { MORPHO_COLLATERAL_ADDRESSES } from "@/lib/constants";
import type { MorphoMarket } from "@/lib/types";
import type { SwapConfig } from "@/lib/swapQuotes";
import type { GasProfile } from "@/lib/gasEstimates";
import { getAddress } from "viem";
import ParameterInputs from "./backtest/ParameterInputs";
import OracleDeviation from "./backtest/OracleDeviation";
import BorrowRateHistory from "./backtest/BorrowRateHistory";
import MarginForError from "./backtest/MarginForError";
import EquityChart from "./backtest/EquityChart";
import HealthFactorChart from "./backtest/HealthFactorChart";
import OptimizationHeatmap from "./backtest/OptimizationHeatmap";
import CapacityCurve from "./backtest/CapacityCurve";
import ExitSignalTable from "./backtest/ExitSignalTable";
import EntryCostCalculator from "./EntryCostCalculator";

// ── Token addresses ─────────────────────────────────────────────────

const TOK = {
  USDT: {
    address: getAddress("0xdAC17F958D2ee523a2206206994597C13D831ec7"),
    decimals: 6,
    symbol: "USDT",
  },
  USDC: {
    address: getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
    decimals: 6,
    symbol: "USDC",
  },
  sUSDS: {
    address: getAddress("0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD"),
    decimals: 18,
    symbol: "sUSDS",
  },
  WETH: {
    address: getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
    decimals: 18,
    symbol: "WETH",
  },
  wstETH: {
    address: getAddress("0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0"),
    decimals: 18,
    symbol: "wstETH",
  },
};

// Curve pools referenced by the calculator
const CURVE_POOLS = {
  // sUSDS/USDT StableSwap (coin0=sUSDS 18dp, coin1=USDT 6dp), legacy int128
  SUSDS_USDT: getAddress("0x00836fE54625bE242bcfA286207795405cA4FD10"),
  // wstETH/ETH pool (legacy int128, fee 0.04%)
  WSTETH_ETH: getAddress("0xDC24316b9AE028F1497c275EB9192a3Ea0f67022"),
};

// ── Market configurations ───────────────────────────────────────────

type MarketOption = {
  label: string;
  collateralAsset: string;
  borrowAsset: string;
  vaultAddress: string;
  loaderType: "stablecoin" | "wsteth";
  venue: "Morpho" | "Aave";
  disabled?: boolean;
  disabledReason?: string;
  aaveLiquidationLtv?: number;
  aaveBorrowApy?: number | null;
  swapConfig: SwapConfig;
  gasProfile: GasProfile;
};

const MARKET_OPTIONS: MarketOption[] = [
  {
    label: "sUSDS / USDT (Morpho)",
    collateralAsset: "sUSDS",
    borrowAsset: "USDT",
    vaultAddress: MORPHO_COLLATERAL_ADDRESSES.sUSDS,
    loaderType: "stablecoin",
    venue: "Morpho",
    swapConfig: {
      label: "USDT ↔ sUSDS",
      debtToken: TOK.USDT,
      collateralToken: TOK.sUSDS,
      curve: {
        address: CURVE_POOLS.SUSDS_USDT,
        // coin0 = sUSDS, coin1 = USDT
        entryFromIdx: 1, // USDT in
        entryToIdx: 0, // sUSDS out
        abi: "int128",
        feePct: 0.0004,
      },
      uniswapV3: { feeTier: 100 },
      aggregator: true,
    },
    gasProfile: {
      lender: "morpho",
      // supply + borrow + swap already counted; extra = Sky SavingsRate stake
      perLoopExtras: 60_000,
      label: "Morpho Blue + Sky",
    },
  },
  {
    label: "sUSDS / USDC (Morpho)",
    collateralAsset: "sUSDS",
    borrowAsset: "USDC",
    vaultAddress: MORPHO_COLLATERAL_ADDRESSES.sUSDS,
    loaderType: "stablecoin",
    venue: "Morpho",
    swapConfig: {
      label: "USDC ↔ sUSDS",
      debtToken: TOK.USDC,
      collateralToken: TOK.sUSDS,
      // No deep direct Curve pool; leave Curve off and let aggregator + Uni V3
      uniswapV3: { feeTier: 100 },
      aggregator: true,
    },
    gasProfile: {
      lender: "morpho",
      perLoopExtras: 60_000,
      label: "Morpho Blue + Sky",
    },
  },
  {
    label: "sUSDE / USDT (Morpho) — not supported",
    collateralAsset: "sUSDE",
    borrowAsset: "USDT",
    vaultAddress: MORPHO_COLLATERAL_ADDRESSES.sUSDE,
    loaderType: "stablecoin",
    venue: "Morpho",
    disabled: true,
    disabledReason:
      "Backtester currently models only sUSDS and wstETH/ETH oracles accurately",
    swapConfig: {
      label: "USDT ↔ sUSDE",
      debtToken: TOK.USDT,
      collateralToken: TOK.USDT, // placeholder — unused while disabled
      aggregator: true,
    },
    gasProfile: { lender: "morpho", perLoopExtras: 0, label: "Morpho Blue" },
  },
  {
    label: "sUSDE / USDC (Morpho) — not supported",
    collateralAsset: "sUSDE",
    borrowAsset: "USDC",
    vaultAddress: MORPHO_COLLATERAL_ADDRESSES.sUSDE,
    loaderType: "stablecoin",
    venue: "Morpho",
    disabled: true,
    disabledReason:
      "Backtester currently models only sUSDS and wstETH/ETH oracles accurately",
    swapConfig: {
      label: "USDC ↔ sUSDE",
      debtToken: TOK.USDC,
      collateralToken: TOK.USDC,
      aggregator: true,
    },
    gasProfile: { lender: "morpho", perLoopExtras: 0, label: "Morpho Blue" },
  },
  {
    label: "wstETH / WETH (Morpho)",
    collateralAsset: "wstETH",
    borrowAsset: "WETH",
    vaultAddress: MORPHO_COLLATERAL_ADDRESSES.wstETH,
    loaderType: "wsteth",
    venue: "Morpho",
    swapConfig: {
      label: "WETH ↔ wstETH",
      debtToken: TOK.WETH,
      collateralToken: TOK.wstETH,
      curve: {
        address: CURVE_POOLS.WSTETH_ETH,
        // coin0 = ETH (native, but Curve uses WETH placeholder via adaptor)
        // This pool is stETH/ETH. wstETH is routed through wrap/unwrap.
        // For direct wstETH/WETH, we rely on Uniswap V3 / aggregator instead.
        entryFromIdx: 0,
        entryToIdx: 1,
        abi: "int128",
        feePct: 0.0004,
      },
      uniswapV3: { feeTier: 100 }, // 0.01% wstETH/WETH
      aggregator: true,
    },
    gasProfile: {
      lender: "morpho",
      // extras: wrap WETH on loop, wstETH wrap when building position
      perLoopExtras: 30_000,
      label: "Morpho Blue",
    },
  },
  {
    label: "wstETH / ETH (Aave V3, E-Mode)",
    collateralAsset: "wstETH",
    borrowAsset: "WETH",
    vaultAddress: MORPHO_COLLATERAL_ADDRESSES.wstETH,
    loaderType: "wsteth",
    venue: "Aave",
    aaveLiquidationLtv: 0.93,
    aaveBorrowApy: null,
    swapConfig: {
      label: "WETH ↔ wstETH",
      debtToken: TOK.WETH,
      collateralToken: TOK.wstETH,
      uniswapV3: { feeTier: 100 },
      aggregator: true,
    },
    gasProfile: {
      lender: "aave-v3-emode",
      perLoopExtras: 30_000,
      label: "Aave V3 E-Mode",
    },
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
  const isAaveMarket = selectedOption.venue === "Aave";
  const isEthDebt = selectedOption.loaderType === "wsteth"; // borrow asset is WETH

  // Resolve market — pick highest liquidity (Morpho markets only)
  const resolvedMarket = isAaveMarket
    ? null
    : morphoMarkets
        .filter(
          (m) =>
            m.collateralAsset.address.toLowerCase() === selectedOption.vaultAddress.toLowerCase() &&
            m.loanAsset.symbol.toUpperCase() === selectedOption.borrowAsset.toUpperCase()
        )
        .sort((a, b) => (b.state.liquidityAssetsUsd ?? 0) - (a.state.liquidityAssetsUsd ?? 0))[0] ?? null;

  const marketUniqueKey = resolvedMarket?.uniqueKey ?? (isAaveMarket ? "aave-wsteth-eth" : "");
  const liquidationLtv = isAaveMarket
    ? (selectedOption.aaveLiquidationLtv ?? 0.93)
    : resolvedMarket
      ? Number(resolvedMarket.lltv) / 1e18
      : 0.86;

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
          debtDenomination: isEthDebt ? "ETH" : "USD",
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
          loaderType: selectedOption.loaderType,
        });
      }
    },
    [data, marketUniqueKey, selectedOption, isEthDebt, runSingleBacktest, loadData]
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
        debtDenomination: isEthDebt ? "ETH" : "USD",
        ...p,
      });
    }
  }, [data, marketUniqueKey, selectedOption, isEthDebt, runSingleBacktest]);

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
                <option key={i} value={i} disabled={opt.disabled}>
                  {opt.label}
                </option>
              ))}
            </select>
            {selectedOption.disabled && selectedOption.disabledReason && (
              <div className="mt-2 text-xs text-amber-400">
                {selectedOption.disabledReason}
              </div>
            )}
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
          {isAaveMarket && (
            <div className="flex gap-4 text-sm text-gray-400 pt-5">
              <span>Liquidation Threshold (E-Mode): <span className="text-gray-200">{(liquidationLtv * 100).toFixed(1)}%</span></span>
              <span>Venue: <span className="text-gray-200">Aave V3 Ethereum</span></span>
            </div>
          )}
        </div>

        {!marketUniqueKey && (
          <div className="mt-3 text-sm text-amber-400">
            Market not found. Make sure the dashboard has loaded.
          </div>
        )}
      </div>

      {/* ── Section 1: Oracle Deviation & Borrow Rate (shown after data loads) ── */}
      {data && data.length > 0 && (
        <>
          <OracleDeviation data={data} assetLabel={selectedOption.loaderType === "wsteth" ? "wstETH" : "sUSDS"} />
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
          debtDenomination={isEthDebt ? "ETH" : "USD"}
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

      {/* ── Section 5: Entry/Exit Cost Calculator ── */}
      {marketUniqueKey && !selectedOption.disabled && (
        <EntryCostCalculator
          ltv={params.ltv}
          leverage={params.leverage}
          startingCapital={params.startingCapital}
          swapConfig={selectedOption.swapConfig}
          gasProfile={selectedOption.gasProfile}
        />
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
              debtDenomination: isEthDebt ? "ETH" : "USD",
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
