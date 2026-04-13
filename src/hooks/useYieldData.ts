"use client";

import useSWR from "swr";
import { ASSETS } from "@/lib/constants";
import { StrategyRow, DefiLlamaPool, DefiLlamaBorrowPool, MorphoMarket, BorrowMarket } from "@/lib/types";
import { fetchPools, fetchBorrowPools, findBaseYieldByPoolId, findBaseYieldByProject, getAaveBorrowMarkets } from "@/lib/api/defillama";
import { fetchMorphoMarkets, getMorphoBorrowMarkets } from "@/lib/api/morpho";
import { findCheapestBorrow, calcSpread, calcNetYield } from "@/lib/calculations";

interface AllData {
  pools: DefiLlamaPool[];
  borrowPools: DefiLlamaBorrowPool[];
  morphoMarkets: MorphoMarket[];
}

async function fetchAllData(): Promise<AllData> {
  const [pools, borrowPools, morphoMarkets] = await Promise.all([
    fetchPools(),
    fetchBorrowPools(),
    fetchMorphoMarkets(),
  ]);
  return { pools, borrowPools, morphoMarkets };
}

function assembleStrategies(data: AllData): StrategyRow[] {
  return ASSETS.map((asset) => {
    // 1. Find base yield - try pool ID first, then project/symbol, then manual
    let baseYield: number | null = null;
    if (asset.baseYieldPoolIds && asset.baseYieldPoolIds.length > 0) {
      baseYield = findBaseYieldByPoolId(data.pools, asset.baseYieldPoolIds);
    }
    if (baseYield === null && asset.baseYieldProject && asset.baseYieldSymbol) {
      baseYield = findBaseYieldByProject(
        data.pools,
        asset.baseYieldProject,
        asset.baseYieldSymbol
      );
    }
    if (baseYield === null && asset.manualBaseYield !== undefined) {
      baseYield = asset.manualBaseYield;
    }

    // 2. Collect all borrow markets
    const allBorrowMarkets: BorrowMarket[] = [];

    for (const venueConfig of asset.borrowVenues) {
      if (
        (venueConfig.venue === "Aave V3" || venueConfig.venue === "Aave Horizon") &&
        venueConfig.poolIds
      ) {
        const aaveMarkets = getAaveBorrowMarkets(
          data.borrowPools,
          asset.name,
          venueConfig.poolIds,
          venueConfig.venue
        );
        allBorrowMarkets.push(...aaveMarkets);
      }

      if (venueConfig.venue === "Morpho" && venueConfig.morphoCollateralAddress) {
        const morphoMarkets = getMorphoBorrowMarkets(
          data.morphoMarkets,
          asset.name,
          venueConfig.morphoCollateralAddress,
          venueConfig.borrowAssets
        );
        allBorrowMarkets.push(...morphoMarkets);
      }
    }

    // 3. Find cheapest borrow and calculate
    const bestBorrow = findCheapestBorrow(allBorrowMarkets);
    const borrowCost = bestBorrow?.borrowRate ?? null;
    const spread = calcSpread(baseYield, borrowCost);
    const net3x = calcNetYield(baseYield, spread, 3);
    const net5x = calcNetYield(baseYield, spread, 5);

    return {
      asset,
      baseYield,
      bestBorrow,
      spread,
      net3x,
      net5x,
      allBorrowMarkets,
    };
  });
}

export function useYieldData() {
  const { data, error, isLoading, mutate } = useSWR<AllData>(
    "yield-data",
    fetchAllData,
    {
      refreshInterval: 5 * 60 * 1000, // 5 minutes
      revalidateOnFocus: false,
      dedupingInterval: 60 * 1000,
    }
  );

  const strategies: StrategyRow[] = data ? assembleStrategies(data) : [];

  return {
    strategies,
    isLoading,
    error,
    refresh: mutate,
    lastUpdated: data ? new Date() : null,
    // Expose raw data for calculator
    morphoMarkets: data?.morphoMarkets ?? [],
    borrowPools: data?.borrowPools ?? [],
  };
}
