"use client";

interface HeaderProps {
  lastUpdated: Date | null;
  onRefresh: () => void;
  isLoading: boolean;
}

export default function Header({ lastUpdated, onRefresh, isLoading }: HeaderProps) {
  return (
    <header className="flex items-center justify-between mb-8">
      <div>
        <h1 className="text-3xl font-bold text-white">
          Yield Loop Dashboard
        </h1>
        <p className="text-gray-400 mt-1">
          On-chain looping strategies for yield-bearing assets
        </p>
      </div>
      <div className="flex items-center gap-4">
        {lastUpdated && (
          <span className="text-sm text-gray-500">
            Updated {lastUpdated.toLocaleTimeString()}
          </span>
        )}
        <button
          onClick={() => onRefresh()}
          disabled={isLoading}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-800 text-gray-300 border border-gray-700 hover:bg-gray-700 hover:text-white transition-colors disabled:opacity-50"
        >
          {isLoading ? "Loading..." : "Refresh"}
        </button>
      </div>
    </header>
  );
}
