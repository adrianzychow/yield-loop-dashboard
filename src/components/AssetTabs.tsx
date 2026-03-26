"use client";

import { ASSETS } from "@/lib/constants";

interface AssetTabsProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
}

export default function AssetTabs({ activeTab, onTabChange }: AssetTabsProps) {
  const assetTabs = ASSETS.map((a) => a.name);
  const specialTabs = ["Overview", "Calculator", "Flash Loan"];

  const getTabStyle = (tab: string) => {
    if (tab === "Calculator") {
      return activeTab === tab
        ? "bg-purple-600 text-white px-5 py-2.5 text-base font-semibold rounded-lg whitespace-nowrap transition-colors"
        : "bg-purple-900/40 text-purple-300 hover:bg-purple-800/60 hover:text-purple-100 px-5 py-2.5 text-base font-semibold rounded-lg whitespace-nowrap transition-colors";
    }
    if (tab === "Flash Loan") {
      return activeTab === tab
        ? "bg-sky-600 text-white px-4 py-2 text-sm font-medium rounded-lg whitespace-nowrap transition-colors"
        : "bg-sky-900/30 text-sky-300 hover:bg-sky-800/50 hover:text-sky-100 px-4 py-2 text-sm font-medium rounded-lg whitespace-nowrap transition-colors";
    }
    return activeTab === tab
      ? "bg-emerald-600 text-white px-4 py-2 text-sm font-medium rounded-lg whitespace-nowrap transition-colors"
      : "bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200 px-4 py-2 text-sm font-medium rounded-lg whitespace-nowrap transition-colors";
  };

  const allTabs = [...specialTabs, ...assetTabs];

  return (
    <div className="flex gap-1 mb-6 overflow-x-auto pb-2 items-center">
      {allTabs.map((tab) => (
        <button
          key={tab}
          onClick={() => onTabChange(tab)}
          className={getTabStyle(tab)}
        >
          {tab === "Flash Loan" ? "⚡ Flash Loan" : tab}
        </button>
      ))}
    </div>
  );
}
