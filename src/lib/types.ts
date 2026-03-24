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
  };
  lltv: string;
}
