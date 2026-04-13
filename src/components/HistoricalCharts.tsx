"use client";

import { useState } from "react";
import { AssetConfig, MorphoMarket, DateRange } from "@/lib/types";
import { useHistoricalData } from "@/hooks/useHistoricalData";
import DateRangeToggle from "./charts/DateRangeToggle";
import PriceChart from "./charts/PriceChart";
import OraclePriceOverlay from "./charts/OraclePriceOverlay";
import ApyChart from "./charts/ApyChart";
import AprSummary from "./charts/AprSummary";
import BorrowRatesChart from "./charts/BorrowRatesChart";

interface Props {
  asset: AssetConfig;
  morphoMarkets: MorphoMarket[];
}

export default function HistoricalCharts({ asset, morphoMarkets }: Props) {
  const [range, setRange] = useState<DateRange>("3m");
  const { priceHistory, apyHistory, borrowRateSeries, isLoading } =
    useHistoricalData(asset, morphoMarkets, range);

  // Show oracle overlay for sUSDS and wstETH (assets with on-chain oracle data)
  const showOracleOverlay = asset.name === "sUSDS" || asset.name === "wstETH";

  return (
    <div className="mt-8">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-white">Historical Data</h3>
        <DateRangeToggle selected={range} onChange={setRange} />
      </div>

      {isLoading && (
        <div className="text-center text-gray-500 py-8 animate-pulse">
          Loading historical data...
        </div>
      )}

      <div className="grid gap-4">
        {showOracleOverlay ? (
          <OraclePriceOverlay
            coingeckoData={priceHistory}
            range={range}
            assetName={asset.displayName}
          />
        ) : (
          <PriceChart
            data={priceHistory}
            range={range}
            assetName={asset.displayName}
          />
        )}
        <ApyChart
          data={apyHistory}
          range={range}
          assetName={asset.displayName}
        />
        <AprSummary apyData={apyHistory} />
        <BorrowRatesChart series={borrowRateSeries} range={range} />
      </div>
    </div>
  );
}
