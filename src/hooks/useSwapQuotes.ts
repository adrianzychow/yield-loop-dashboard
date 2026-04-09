"use client";

import { useState, useCallback, useRef } from "react";
import { createPublicClient, http, type PublicClient } from "viem";
import { mainnet } from "viem/chains";
import {
  fetchUniswapPoolData,
  computeUniswapCosts,
  fetchCurveCosts,
  compareVenues,
  type VenueComparison,
  type SwapCostResult,
} from "@/lib/swapQuotes";
import {
  loopCount,
  perLoopSwapAmounts,
  totalSwapVolume,
  computeGasCosts,
  gasToUsd,
  type GasCostBreakdown,
} from "@/lib/gasEstimates";

// ── Types ──────────────────────────────────────────────────────────

export interface EntryCostParams {
  startingCapital: number;
  leverage: number;
  ltv: number;
  gasPriceGwei: number;
  ethUsdPrice: number;
}

export interface CostSummary {
  loops: number;
  totalSwapVol: number;
  // Venue comparison (entry direction)
  entryVenues: VenueComparison;
  // Venue comparison (exit direction)
  exitVenues: VenueComparison;
  // Gas breakdowns (using recommended venue's gas profile)
  entryGas: GasCostBreakdown;
  exitGas: GasCostBreakdown;
  // USD gas costs
  entryGasManualUsd: number;
  entryGasFlashBalancerUsd: number;
  entryGasFlashMorphoUsd: number;
  exitGasManualUsd: number;
  exitGasFlashBalancerUsd: number;
  exitGasFlashMorphoUsd: number;
  // Totals
  entryTotalManual: number;
  entryTotalFlash: number;
  exitTotalManual: number;
  exitTotalFlash: number;
  flashSavingEntry: number;
  flashSavingExit: number;
}

// ── Hook ───────────────────────────────────────────────────────────

export function useSwapQuotes() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CostSummary | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
            transport: http(rpcUrl, { retryCount: 2, timeout: 15_000 }),
          }) as PublicClient;
        }
        const client = clientRef.current;

        const { startingCapital, leverage, ltv, gasPriceGwei, ethUsdPrice } = params;
        const loops = loopCount(leverage, ltv);
        const swapAmounts = perLoopSwapAmounts(startingCapital, ltv, loops);
        const totalVol = totalSwapVolume(startingCapital, leverage);

        // Fetch Curve and Uniswap quotes in parallel
        const [curveEntry, curvExit, uniPool] = await Promise.all([
          fetchCurveCosts(client, swapAmounts, "entry"),
          fetchCurveCosts(client, swapAmounts, "exit"),
          fetchUniswapPoolData(client),
        ]);

        // Compute Uniswap costs if pool data available
        let uniEntry: SwapCostResult | null = null;
        let uniExit: SwapCostResult | null = null;
        if (uniPool) {
          uniEntry = computeUniswapCosts(swapAmounts, uniPool);
          // Exit direction: same amounts, same pool depth approximation
          uniExit = computeUniswapCosts(swapAmounts, uniPool);
        }

        const entryVenues = compareVenues(curveEntry, uniEntry, totalVol);
        const exitVenues = compareVenues(curvExit, uniExit, totalVol);

        // Gas costs — use recommended venue's swap gas
        const entryGasVenue = entryVenues.recommended;
        const exitGasVenue = exitVenues.recommended;
        const entryGas = computeGasCosts(loops, entryGasVenue);
        const exitGas = computeGasCosts(loops, exitGasVenue);

        const entryGasManualUsd = gasToUsd(entryGas.manualTotal, gasPriceGwei, ethUsdPrice);
        const entryGasFlashBalancerUsd = gasToUsd(entryGas.flashBalancerTotal, gasPriceGwei, ethUsdPrice);
        const entryGasFlashMorphoUsd = gasToUsd(entryGas.flashMorphoTotal, gasPriceGwei, ethUsdPrice);
        const exitGasManualUsd = gasToUsd(exitGas.manualTotal, gasPriceGwei, ethUsdPrice);
        const exitGasFlashBalancerUsd = gasToUsd(exitGas.flashBalancerTotal, gasPriceGwei, ethUsdPrice);
        const exitGasFlashMorphoUsd = gasToUsd(exitGas.flashMorphoTotal, gasPriceGwei, ethUsdPrice);

        // Pick recommended swap costs
        const entrySwapCost =
          entryVenues.recommended === "curve"
            ? entryVenues.curve.totalCost
            : (entryVenues.uniswap?.totalCost ?? entryVenues.curve.totalCost);
        const exitSwapCost =
          exitVenues.recommended === "curve"
            ? exitVenues.curve.totalCost
            : (exitVenues.uniswap?.totalCost ?? exitVenues.curve.totalCost);

        const entryTotalManual = entryGasManualUsd + entrySwapCost;
        const entryTotalFlash = Math.min(entryGasFlashBalancerUsd, entryGasFlashMorphoUsd) + entrySwapCost;
        const exitTotalManual = exitGasManualUsd + exitSwapCost;
        const exitTotalFlash = Math.min(exitGasFlashBalancerUsd, exitGasFlashMorphoUsd) + exitSwapCost;

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
          exitGasManualUsd,
          exitGasFlashBalancerUsd,
          exitGasFlashMorphoUsd,
          entryTotalManual,
          entryTotalFlash,
          exitTotalManual,
          exitTotalFlash,
          flashSavingEntry: entryTotalManual - entryTotalFlash,
          flashSavingExit: exitTotalManual - exitTotalFlash,
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
