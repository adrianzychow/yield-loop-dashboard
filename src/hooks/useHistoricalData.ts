"use client";

import useSWR from "swr";
import {
  AssetConfig,
  MorphoMarket,
  DateRange,
  HistoricalDataPoint,
  BorrowRateSeries,
} from "@/lib/types";
import { fetchPoolChart } from "@/lib/api/defillama";
import { fetchMorphoHistory } from "@/lib/api/morpho";
import { fetchPriceHistory } from "@/lib/api/coingecko";
import {
  rangeToDays,
  parseDefiLlamaChart,
  parseMorphoHistory,
  parseCoinGeckoPrice,
  filterByRange,
  SERIES_COLORS,
} from "@/lib/chartUtils";

interface HistoricalResult {
  price: HistoricalDataPoint[];
  apy: HistoricalDataPoint[];
  borrowSeries: BorrowRateSeries[];
}

async function fetchAssetHistory(
  asset: AssetConfig,
  morphoMarkets: MorphoMarket[],
  range: DateRange
): Promise<HistoricalResult> {
  const days = rangeToDays(range);

  // 1. Price history from CoinGecko (max 365 on free tier)
  const pricePromise = fetchPriceHistory(asset.name, Math.min(days, 365))
    .then(parseCoinGeckoPrice)
    .catch(() => [] as HistoricalDataPoint[]);

  // 2. APY history from DefiLlama
  let apyPromise: Promise<HistoricalDataPoint[]>;
  if (asset.baseYieldPoolIds && asset.baseYieldPoolIds.length > 0) {
    apyPromise = fetchPoolChart(asset.baseYieldPoolIds[0])
      .then((raw) => parseDefiLlamaChart(raw, "apy"))
      .catch(() => []);
  } else {
    apyPromise = Promise.resolve([]);
  }

  // 3. Borrow rate history
  const borrowPromises: Promise<BorrowRateSeries>[] = [];
  let colorIdx = 0;

  for (const venue of asset.borrowVenues) {
    if (
      (venue.venue === "Aave V3" || venue.venue === "Aave Horizon") &&
      venue.poolIds
    ) {
      for (const [borrowAsset, poolId] of Object.entries(venue.poolIds)) {
        const color = SERIES_COLORS[colorIdx++ % SERIES_COLORS.length];
        const label = `${venue.venue} ${borrowAsset}`;
        borrowPromises.push(
          fetchPoolChart(poolId)
            .then((raw) => ({
              config: { venue: venue.venue, borrowAsset, label, color },
              data: parseDefiLlamaChart(raw, "apy"),
            }))
            .catch(() => ({
              config: { venue: venue.venue, borrowAsset, label, color },
              data: [],
            }))
        );
      }
    }

    if (venue.venue === "Morpho" && venue.morphoCollateralAddress) {
      const relevantMarkets = morphoMarkets.filter(
        (m) =>
          m.collateralAsset.address.toLowerCase() ===
            venue.morphoCollateralAddress!.toLowerCase() &&
          (m.state.liquidityAssetsUsd ?? 0) >= 1000 &&
          (!venue.borrowAssets ||
            venue.borrowAssets.some(
              (a) => a.toUpperCase() === m.loanAsset.symbol.toUpperCase()
            ))
      );
      for (const market of relevantMarkets) {
        const color = SERIES_COLORS[colorIdx++ % SERIES_COLORS.length];
        const label = `Morpho ${market.loanAsset.symbol}`;
        borrowPromises.push(
          fetchMorphoHistory(market.uniqueKey)
            .then((raw) => ({
              config: {
                venue: "Morpho",
                borrowAsset: market.loanAsset.symbol,
                label,
                color,
              },
              data: parseMorphoHistory(raw),
            }))
            .catch(() => ({
              config: {
                venue: "Morpho",
                borrowAsset: market.loanAsset.symbol,
                label,
                color,
              },
              data: [],
            }))
        );
      }
    }
  }

  const [price, apy, ...borrowResults] = await Promise.all([
    pricePromise,
    apyPromise,
    ...borrowPromises,
  ]);

  return {
    price,
    apy,
    borrowSeries: borrowResults.filter((s) => s.data.length > 0),
  };
}

export function useHistoricalData(
  asset: AssetConfig | null,
  morphoMarkets: MorphoMarket[],
  range: DateRange
) {
  const { data, error, isLoading } = useSWR(
    asset ? `history-${asset.name}-${range}` : null,
    () => fetchAssetHistory(asset!, morphoMarkets, range),
    {
      revalidateOnFocus: false,
      dedupingInterval: 10 * 60 * 1000,
      keepPreviousData: true,
    }
  );

  return {
    priceHistory: data ? filterByRange(data.price, range) : [],
    apyHistory: data ? filterByRange(data.apy, range) : [],
    borrowRateSeries: data
      ? data.borrowSeries.map((s) => ({
          ...s,
          data: filterByRange(s.data, range),
        }))
      : [],
    isLoading,
    error,
  };
}
