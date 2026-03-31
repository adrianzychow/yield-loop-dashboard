/**
 * Backtesting simulation engine.
 * Runs hourly step-by-step simulation of a looping strategy.
 */

import type {
  BacktestConfig,
  BacktestResult,
  HourlyDataPoint,
  HourlySnapshot,
} from "./types";

/**
 * Run a full backtest simulation over historical data.
 *
 * Position mechanics:
 * - At entry: deposit collateral, borrow, and loop to target leverage
 * - Collateral value tracks oracle price (includes exchange rate + price feeds)
 * - Debt accrues interest hourly based on historical Morpho borrow APY
 * - Health factor = (collateralValue × LLTV) / debtValue
 * - Liquidation occurs when health factor < 1.0
 */
export function runBacktest(
  config: BacktestConfig,
  data: HourlyDataPoint[]
): BacktestResult {
  if (data.length === 0) {
    throw new Error("No data points for backtest");
  }

  // Filter data to config time range if specified
  let series = data;
  if (config.startTimestamp) {
    series = series.filter((d) => d.timestamp >= config.startTimestamp!);
  }
  if (config.endTimestamp) {
    series = series.filter((d) => d.timestamp <= config.endTimestamp!);
  }

  if (series.length === 0) {
    throw new Error("No data points within specified time range");
  }

  const entry = series[0];
  const { startingCapital, leverage, liquidationLtv } = config;

  // ── Entry position ──────────────────────────────────────────────
  // Total assets = startingCapital × leverage
  // Debt = totalAssets - startingCapital
  const totalAssetsUsd = startingCapital * leverage;
  const initialDebtUsd = totalAssetsUsd - startingCapital;

  // Collateral units (in sUSDS terms) based on entry oracle price
  const collateralUnits = totalAssetsUsd / entry.oraclePrice;

  // ── Simulation loop ─────────────────────────────────────────────
  const snapshots: HourlySnapshot[] = [];
  let debtValue = initialDebtUsd;
  let liquidated = false;
  let liquidationTimestamp: number | undefined;
  let peakEquity = startingCapital;
  let maxDrawdown = 0;
  let minHealthFactor = Infinity;
  let minHealthFactorTimestamp = entry.timestamp;
  let totalBorrowApy = 0;

  for (let i = 0; i < series.length; i++) {
    const point = series[i];

    // Accrue hourly interest on debt
    if (i > 0) {
      const hourlyRate = point.borrowApy / 8760;
      debtValue = debtValue * (1 + hourlyRate);
    }

    // Current collateral value per oracle
    const collateralValue = collateralUnits * point.oraclePrice;

    // Health factor
    const healthFactor =
      debtValue > 0
        ? (collateralValue * liquidationLtv) / debtValue
        : Infinity;

    // Equity
    const equity = collateralValue - debtValue;

    // Returns
    const cumulativeReturn = equity / startingCapital - 1;
    const hoursElapsed = i + 1;
    const yearsElapsed = hoursElapsed / 8760;
    const annualizedReturn =
      yearsElapsed > 0
        ? Math.pow(1 + cumulativeReturn, 1 / yearsElapsed) - 1
        : 0;

    // Track drawdown
    if (equity > peakEquity) peakEquity = equity;
    const drawdown = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;

    // Track min health factor
    if (healthFactor < minHealthFactor) {
      minHealthFactor = healthFactor;
      minHealthFactorTimestamp = point.timestamp;
    }

    totalBorrowApy += point.borrowApy;

    snapshots.push({
      timestamp: point.timestamp,
      oraclePrice: point.oraclePrice,
      collateralValue,
      debtValue,
      equity,
      healthFactor,
      borrowApy: point.borrowApy,
      cumulativeReturn,
      annualizedReturn,
    });

    // Check liquidation
    if (healthFactor < 1.0 && !liquidated) {
      liquidated = true;
      liquidationTimestamp = point.timestamp;
      // Continue simulation to show what happens post-liquidation
    }
  }

  const lastSnapshot = snapshots[snapshots.length - 1];

  return {
    config,
    snapshots,
    totalHours: series.length,
    finalEquity: lastSnapshot.equity,
    annualizedReturn: lastSnapshot.annualizedReturn,
    maxDrawdown,
    minHealthFactor: minHealthFactor === Infinity ? 0 : minHealthFactor,
    minHealthFactorTimestamp,
    avgBorrowApy: totalBorrowApy / series.length,
    liquidated,
    liquidationTimestamp,
    entryOraclePrice: entry.oraclePrice,
    entryBorrowApy: entry.borrowApy,
  };
}
