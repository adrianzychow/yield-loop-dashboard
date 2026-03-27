export interface BorrowVenueConfig {
  venue: string;
  borrowAssets: string[];
  // DeFiLlama pool IDs for Aave markets (keyed by borrow asset symbol)
  poolIds?: Record<string, string>;
  // Morpho collateral address for GraphQL filtering
  morphoCollateralAddress?: string;
}

export interface AssetConfig {
  name: string;
  displayName: string;
  chain: string;
  // DeFiLlama pool ID(s) to look up base yield
  baseYieldPoolIds?: string[];
  // Search hints for finding base yield pool
  baseYieldProject?: string;
  baseYieldSymbol?: string;
  // Fallback manual APY if API doesn't return data
  manualBaseYield?: number;
  borrowVenues: BorrowVenueConfig[];
}

export interface BorrowMarket {
  venue: string;
  pair: string;
  borrowAsset: string;
  borrowRate: number;
  liquidity: number;
  link: string;
  utilization?: number | null; // 0-1 decimal
}

export interface StrategyRow {
  asset: AssetConfig;
  baseYield: number | null;
  bestBorrow: BorrowMarket | null;
  spread: number | null;
  net3x: number | null;
  net5x: number | null;
  allBorrowMarkets: BorrowMarket[];
}

// DeFiLlama API types
export interface DefiLlamaPool {
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apyBase: number | null;
  apyReward: number | null;
  apy: number | null;
  pool: string;
  poolMeta: string | null;
  underlyingTokens: string[] | null;
  stablecoin: boolean;
}

export interface DefiLlamaBorrowPool extends DefiLlamaPool {
  apyBaseBorrow: number | null;
  apyRewardBorrow: number | null;
  totalSupplyUsd: number | null;
  totalBorrowUsd: number | null;
  ltv: number | null;
  borrowable: boolean;
}

// Morpho GraphQL types
export interface MorphoMarket {
  uniqueKey: string;
  loanAsset: { symbol: string; address: string };
  collateralAsset: { symbol: string; address: string };
  state: {
    borrowApy: number | null;
    supplyApy: number | null;
    liquidityAssetsUsd: number | null;
    apyAtTarget: number | null;
    utilization: number | null;
    borrowAssetsUsd: number | null;
    supplyAssetsUsd: number | null;
  };
  lltv: string;
}

// Calculator types
export interface DebtOption {
  label: string; // e.g. "PYUSD (Morpho)"
  venue: string;
  borrowAsset: string;
  currentBorrowApy: number;
  liquidationLtv: number; // 0-1
  // For IRM calculation
  totalBorrowedUsd: number;
  totalSuppliedUsd: number;
  // Morpho-specific
  morphoApyAtTarget?: number;
}

export interface CalculatorOutputs {
  assets: number;
  debt: number;
  collateralApy: number;
  estimatedBorrowApy: number;
  apyPriceImpact: number;
  loopsRequired: number;
  liquidationPrice: number;
  netApy: number;
}

// Historical chart types
export type DateRange = "1m" | "3m" | "1y" | "max";

export interface HistoricalDataPoint {
  timestamp: number; // Unix seconds
  date: string;
  value: number;
}

export interface DefiLlamaChartPoint {
  timestamp: string;
  tvlUsd: number;
  apy: number;
  apyBase: number | null;
  apyReward: number | null;
  il7d: number | null;
  apyBase7d: number | null;
}

export interface MorphoHistoricalPoint {
  x: number;
  y: number;
}

export interface CoinGeckoPricePoint {
  timestamp: number;
  price: number;
}

export interface BorrowRateSeriesConfig {
  venue: string;
  borrowAsset: string;
  label: string;
  color: string;
}

export interface BorrowRateSeries {
  config: BorrowRateSeriesConfig;
  data: HistoricalDataPoint[];
}
