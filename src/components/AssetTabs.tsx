"use client";

import { ASSETS } from "@/lib/constants";

interface AssetTabsProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
}

export default function AssetTabs({ activeTab, onTabChange }: AssetTabsProps) {
  const tabs = ["Overview", ...ASSETS.map((a) => a.name)];

  return (
    <div className="flex gap-1 mb-6 overflow-x-auto pb-2">
      {tabs.map((tab) => (
        <button
          key={tab}
          onClick={() => onTabChange(tab)}
          className={`px-4 py-2 text-sm font-medium rounded-lg whitespace-nowrap transition-colors ${
            activeTab === tab
              ? "bg-emerald-600 text-white"
              : "bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200"
          }`}
        >
          {tab}
        </button>
      ))}
    </div>
  );
}
