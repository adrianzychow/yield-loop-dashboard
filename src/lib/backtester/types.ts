/**
 * Backtester types for looping strategy simulation.
 */

// ── Data types ──────────────────────────────────────────────────────

/** A single hourly data point with all oracle components + borrow rate */
export interface HourlyDataPoint {
  timestamp: number; // Unix seconds
  blockNumber: number;
  // Oracle components
  exchangeRate: number; // sUSDS → USDS (decimal, e.g., 1.05 means 1 sUSDS = 1.05 USDS)
  basePrice: number; // USDS/USD from CoinGecko
  quotePrice: number; // USDT/USD from CoinGecko
  // Computed oracle price
  oraclePrice: number; // (exchangeRate × basePrice) / quotePrice
  // Market data
  borrowApy: number; // Morpho borrow APY (decimal, e.g., 0.03 = 3%)
}

/** Raw fetched data before alignment */
export interface RawHistoricalData {
  exchangeRates: { timestamp: number; blockNumber: number; rate: number }[];
  basePrices: { timestamp: number; price: number }[]; // USDS/USD
  quotePrices: { timestamp: number; price: number }[]; // USDT/USD
  borrowRates: { timestamp: number; rate: number }[]; // Morpho APY decimal
}

// ── Configuration ───────────────────────────────────────────────────

export interface BacktestConfig {
  // Market identification
  marketUniqueKey: string;
  collateralAsset: string; // e.g., "sUSDS"
  borrowAsset: string; // e.g., "USDT"
  // Strategy parameters
  startingCapital: number; // USD
  ltv: number; // 0-1 (e.g., 0.80)
  leverage: number; // e.g., 3.0
  // Market parameters
  liquidationLtv: number; // From Morpho market LLTV (0-1)
  // Time range
  startTimestamp?: number; // Unix seconds, defaults to earliest data
  endTimestamp?: number; // Unix seconds, defaults to latest data
}

export interface CapacityConfig extends BacktestConfig {
  // Current market state for IRM modeling
  currentSupplyUsd: number;
  currentBorrowUsd: number;
  apyAtTarget: number; // Morpho IRM parameter
}

// ── Results ─────────────────────────────────────────────────────────

export interface HourlySnapshot {
  timestamp: number;
  oraclePrice: number;
  collateralValue: number; // collateral_units × oracle_price
  debtValue: number; // accumulated debt in USDT terms
  equity: number; // collateralValue - debtValue
  healthFactor: number; // (collateralValue × LLTV) / debtValue
  borrowApy: number; // current hourly borrow rate (annualized)
  cumulativeReturn: number; // (equity / startingCapital) - 1
  annualizedReturn: number; // annualized from cumulative
}

export interface BacktestResult {
  config: BacktestConfig;
  snapshots: HourlySnapshot[];
  // Summary statistics
  totalHours: number;
  finalEquity: number;
  annualizedReturn: number;
  maxDrawdown: number; // worst peak-to-trough as fraction
  minHealthFactor: number;
  minHealthFactorTimestamp: number;
  avgBorrowApy: number;
  liquidated: boolean;
  liquidationTimestamp?: number;
  // Entry conditions
  entryOraclePrice: number;
  entryBorrowApy: number;
}

// ── Optimization ────────────────────────────────────────────────────

export interface OptimizationPoint {
  ltv: number;
  leverage: number;
  annualizedReturn: number;
  maxDrawdown: number;
  minHealthFactor: number;
  liquidated: boolean;
}

export interface OptimizationResult {
  points: OptimizationPoint[];
  optimal: OptimizationPoint | null; // best return with no liquidation
  ltvRange: [number, number];
  leverageRange: [number, number];
}

// ── Capacity ────────────────────────────────────────────────────────

export interface CapacityPoint {
  capitalUsd: number;
  additionalDebtUsd: number;
  newUtilization: number;
  estimatedBorrowApy: number; // after IRM adjustment
  netApy: number;
  utilizationImpact: number; // increase in utilization
}

export interface CapacityResult {
  points: CapacityPoint[];
  optimalSize: number; // USD where marginal return starts declining sharply
  breakEvenSize: number; // USD where net APY → 0
  maxSafeSize: number; // USD where utilization stays < 95%
}

// ── Exit Signals ────────────────────────────────────────────────────

export type ExitSignalType =
  | "negative_carry"
  | "health_warning"
  | "rate_spike"
  | "utilization_squeeze"
  | "spread_compression"
  | "depeg_alert";

export interface ExitSignal {
  type: ExitSignalType;
  label: string;
  description: string;
  threshold: number;
  // Backtest results
  triggerCount: number;
  triggerTimestamps: number[];
  wouldHaveExited: boolean; // first trigger before any liquidation
  avgReturnAtTrigger: number; // avg cumulative return when triggered
}

export interface ExitAnalysisResult {
  signals: ExitSignal[];
  collateralApy: number; // avg over period for reference
}

// ── API request/response ────────────────────────────────────────────

export interface BacktestDataRequest {
  collateralAsset: string;
  borrowAsset: string;
  marketUniqueKey: string;
  // Contract addresses for on-chain queries
  vaultAddress: string;
  // Time range
  startTimestamp: number;
  endTimestamp: number;
}

export interface BacktestDataResponse {
  data: HourlyDataPoint[];
  metadata: {
    startBlock: number;
    endBlock: number;
    totalPoints: number;
    dataGaps: number; // hours with missing/interpolated data
  };
}
