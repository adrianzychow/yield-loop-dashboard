"use client";

import { useState } from "react";
import { useYieldData } from "@/hooks/useYieldData";
import Header from "@/components/Header";
import AssetTabs from "@/components/AssetTabs";
import SummaryTable from "@/components/SummaryTable";
import AssetDetail from "@/components/AssetDetail";
import LoopingCalculator from "@/components/LoopingCalculator";
import FlashLoanBuilder from "@/components/FlashLoanBuilder";

export default function Home() {
  const [activeTab, setActiveTab] = useState("Overview");
  const { strategies, isLoading, error, refresh, lastUpdated, morphoMarkets, borrowPools } =
    useYieldData();

  const activeStrategy = strategies.find((s) => s.asset.name === activeTab);

  return (
    <main className="max-w-7xl mx-auto px-4 py-8">
      <Header
        lastUpdated={lastUpdated}
        onRefresh={refresh}
        isLoading={isLoading}
      />

      <AssetTabs activeTab={activeTab} onTabChange={setActiveTab} />

      {error && (
        <div className="bg-red-900/20 border border-red-800 rounded-lg p-4 mb-6 text-red-300">
          Failed to load data. Please try refreshing.
        </div>
      )}

      {isLoading && strategies.length === 0 && (
        <div className="flex items-center justify-center py-20">
          <div className="text-gray-400">
            <div className="animate-pulse text-center">
              <div className="text-lg mb-2">Loading yield data...</div>
              <div className="text-sm text-gray-500">
                Fetching from DeFiLlama &amp; Morpho
              </div>
            </div>
          </div>
        </div>
      )}

      {!isLoading && activeTab === "Overview" && (
        <SummaryTable strategies={strategies} onRowClick={setActiveTab} />
      )}

      {!isLoading && activeTab === "Calculator" && (
        <LoopingCalculator
          strategies={strategies}
          morphoMarkets={morphoMarkets}
          borrowPools={borrowPools}
        />
      )}

      {!isLoading && activeTab === "Flash Loan" && (
        <FlashLoanBuilder
          strategies={strategies}
          morphoMarkets={morphoMarkets}
          borrowPools={borrowPools}
        />
      )}

      {!isLoading &&
        activeTab !== "Overview" &&
        activeTab !== "Calculator" &&
        activeTab !== "Flash Loan" &&
        activeStrategy && <AssetDetail strategy={activeStrategy} morphoMarkets={morphoMarkets} />}

      {!isLoading &&
        activeTab !== "Overview" &&
        activeTab !== "Calculator" &&
        activeTab !== "Flash Loan" &&
        !activeStrategy && (
          <div className="text-center text-gray-500 py-12">
            No data found for {activeTab}
          </div>
        )}
    </main>
  );
}
