"use client";

import { useState, useCallback, useRef } from "react";
import { createPublicClient, http, type PublicClient } from "viem";
import { mainnet } from "viem/chains";
import {
  fetchUniswapV3Costs,
  fetchCurveCosts,
  fetchAggregatorCosts,
  compareVenues,
  type VenueComparison,
  type SwapConfig,
  type SwapCostResult,
} from "@/lib/swapQuotes";
import {
  loopCount,
  perLoopSwapAmounts,
  totalSwapVolume,
  computeGasCosts,
  gasToUsd,
  type GasCostBreakdown,
  type GasProfile,
} from "@/lib/gasEstimates";

// ── Types ──────────────────────────────────────────────────────────

export interface EntryCostParams {
  startingCapital: number;
  leverage: number;
  ltv: number;
  gasPriceGwei: number;
  ethUsdPrice: number;
  swapConfig: SwapConfig;
  gasProfile: GasProfile;
}

export interface CostSummary {
  loops: number;
  totalSwapVol: number;
  entryVenues: VenueComparison;
  exitVenues: VenueComparison;
  entryGas: GasCostBreakdown;
  exitGas: GasCostBreakdown;
  entryGasManualUsd: number;
  entryGasFlashBalancerUsd: number;
  entryGasFlashMorphoUsd: number;
  entryGasFlashAaveUsd: number;
  exitGasManualUsd: number;
  exitGasFlashBalancerUsd: number;
  exitGasFlashMorphoUsd: number;
  exitGasFlashAaveUsd: number;
  entryTotalManual: number;
  entryTotalFlash: number;
  exitTotalManual: number;
  exitTotalFlash: number;
  flashSavingEntry: number;
  flashSavingExit: number;
  aggregatorAvailable: boolean;
  aggregatorSource: "0x" | "1inch" | null;
  aggregatorError?: string;
}

// ── Hook ───────────────────────────────────────────────────────────

export function useSwapQuotes() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CostSummary | null>(null);
  const clientRef = useRef<PublicClient | null>(null);

  const fetchQuotes = useCallback(
    async (params: EntryCostParams) => {
      const rpcUrl = process.env.NEXT_PUBLIC_ETH_RPC_URL;
      if (!rpcUrl) {
        setError("No RPC URL configured");
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        if (!clientRef.current) {
          clientRef.current = createPublicClient({
            chain: mainnet,
            transport: http(rpcUrl, { retryCount: 2, timeout: 20_000 }),
          }) as PublicClient;
        }
        const client = clientRef.current;

        const {
          startingCapital,
          leverage,
          ltv,
          gasPriceGwei,
          ethUsdPrice,
          swapConfig,
          gasProfile,
        } = params;

        const loops = loopCount(leverage, ltv);
        // swap amounts in USD (the debt amount per loop)
        const swapAmountsUsd = perLoopSwapAmounts(startingCapital, ltv, loops);
        const totalVol = totalSwapVolume(startingCapital, leverage);

        // Convert USD amounts to input-token units. For stablecoins the debt
        // token is ~1 USD/unit, for WETH we divide by ETH/USD.
        const usdPerDebtToken =
          swapConfig.debtToken.symbol === "WETH" ||
          swapConfig.debtToken.symbol === "ETH"
            ? ethUsdPrice
            : 1;
        const swapAmountsDebtTokens = swapAmountsUsd.map(
          (u) => u / usdPerDebtToken
        );
        // Same amounts sized as collateral tokens for exit direction.
        // For the purpose of cost estimation the absolute size matters less
        // than the shape; we re-use debt-token amounts and rely on the
        // aggregator / pool to report realistic rates.
        const usdPerCollateralToken =
          swapConfig.collateralToken.symbol === "wstETH"
            ? ethUsdPrice * 1.2 // rough wstETH/USD at 1.2 ratio to ETH
            : 1;

        const [curveEntry, curveExit, uniEntry, uniExit, aggEntry, aggExit] =
          await Promise.all([
            fetchCurveCosts(client, swapAmountsUsd, swapConfig, "entry"),
            fetchCurveCosts(client, swapAmountsUsd, swapConfig, "exit"),
            fetchUniswapV3Costs(
              client,
              swapAmountsDebtTokens,
              usdPerDebtToken,
              swapConfig,
              "entry"
            ),
            fetchUniswapV3Costs(
              client,
              swapAmountsUsd.map((u) => u / usdPerCollateralToken),
              usdPerCollateralToken,
              swapConfig,
              "exit"
            ),
            fetchAggregatorCosts(
              swapAmountsDebtTokens,
              usdPerDebtToken,
              swapConfig,
              "entry"
            ),
            fetchAggregatorCosts(
              swapAmountsUsd.map((u) => u / usdPerCollateralToken),
              usdPerCollateralToken,
              swapConfig,
              "exit"
            ),
          ]);

        const entryVenues = compareVenues(curveEntry, uniEntry, aggEntry, totalVol);
        const exitVenues = compareVenues(curveExit, uniExit, aggExit, totalVol);

        const entryGas = computeGasCosts(
          loops,
          entryVenues.recommended,
          gasProfile
        );
        const exitGas = computeGasCosts(
          loops,
          exitVenues.recommended,
          gasProfile
        );

        const g = (units: number) => gasToUsd(units, gasPriceGwei, ethUsdPrice);

        const entryGasManualUsd = g(entryGas.manualTotal);
        const entryGasFlashBalancerUsd = g(entryGas.flashBalancerTotal);
        const entryGasFlashMorphoUsd = g(entryGas.flashMorphoTotal);
        const entryGasFlashAaveUsd = g(entryGas.flashAaveTotal);
        const exitGasManualUsd = g(exitGas.manualTotal);
        const exitGasFlashBalancerUsd = g(exitGas.flashBalancerTotal);
        const exitGasFlashMorphoUsd = g(exitGas.flashMorphoTotal);
        const exitGasFlashAaveUsd = g(exitGas.flashAaveTotal);

        const pickSwapCost = (v: VenueComparison): number => {
          const selected: SwapCostResult =
            v.recommended === "aggregator"
              ? v.aggregator
              : v.recommended === "uniswap"
              ? v.uniswap
              : v.curve;
          return selected.available ? selected.totalCost : 0;
        };

        const entrySwapCost = pickSwapCost(entryVenues);
        const exitSwapCost = pickSwapCost(exitVenues);

        const minFlashGasEntry = Math.min(
          entryGasFlashBalancerUsd,
          entryGasFlashMorphoUsd,
          entryGasFlashAaveUsd
        );
        const minFlashGasExit = Math.min(
          exitGasFlashBalancerUsd,
          exitGasFlashMorphoUsd,
          exitGasFlashAaveUsd
        );

        const entryTotalManual = entryGasManualUsd + entrySwapCost;
        const entryTotalFlash = minFlashGasEntry + entrySwapCost;
        const exitTotalManual = exitGasManualUsd + exitSwapCost;
        const exitTotalFlash = minFlashGasExit + exitSwapCost;

        const aggregatorAvailable =
          aggEntry.available || aggExit.available;
        const aggregatorSource =
          aggEntry.source ?? aggExit.source ?? null;
        const aggregatorError =
          !aggregatorAvailable
            ? aggEntry.warning ?? aggExit.warning ?? undefined
            : undefined;

        setResult({
          loops,
          totalSwapVol: totalVol,
          entryVenues,
          exitVenues,
          entryGas,
          exitGas,
          entryGasManualUsd,
          entryGasFlashBalancerUsd,
          entryGasFlashMorphoUsd,
          entryGasFlashAaveUsd,
          exitGasManualUsd,
          exitGasFlashBalancerUsd,
          exitGasFlashMorphoUsd,
          exitGasFlashAaveUsd,
          entryTotalManual,
          entryTotalFlash,
          exitTotalManual,
          exitTotalFlash,
          flashSavingEntry: entryTotalManual - entryTotalFlash,
          flashSavingExit: exitTotalManual - exitTotalFlash,
          aggregatorAvailable,
          aggregatorSource,
          aggregatorError,
        });
      } catch (err) {
        setError((err as Error).message ?? "Failed to fetch swap quotes");
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  return { result, isLoading, error, fetchQuotes };
}
