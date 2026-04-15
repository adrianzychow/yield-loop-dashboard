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
 * - Collateral value (USD) tracks oracle price (includes exchange rate + price feeds)
 * - Debt accrues interest based on historical borrow APY
 * - Health factor = (collateralValue × LLTV) / debtValue
 * - Liquidation occurs when health factor < 1.0
 *
 * Debt denomination
 * ─────────────────
 * USD mode (default, e.g. sUSDS/USDT):
 *   Debt is USD-pegged. debtValue grows only with borrow rate.
 *
 * ETH mode (e.g. wstETH/ETH loops):
 *   Debt is denominated in WETH. We track debt internally in ETH, so a drop
 *   in ETH/USD does NOT cause liquidation — both collateral_USD and debt_USD
 *   scale with ETH/USD, leaving HF = (wstETH units × wstETH/ETH ratio × LLTV)
 *                                       / debt_ETH. HF becomes ratio-only.
 *
 *   Fields used in ETH mode:
 *     oraclePrice = wstETH/USD = (wstETH/ETH ratio) × (ETH/USD)
 *     basePrice   = ETH/USD
 *   Internally: debt_ETH = initialDebt_USD / ethUsd_at_entry, and
 *               debt_USD_at_step = debt_ETH × basePrice_at_step.
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
  const useEthDenom = config.debtDenomination === "ETH";

  // ── Entry position ──────────────────────────────────────────────
  // Total assets = startingCapital × leverage
  // Debt = totalAssets - startingCapital
  const totalAssetsUsd = startingCapital * leverage;
  const initialDebtUsd = totalAssetsUsd - startingCapital;

  // Collateral units (wstETH / sUSDS / etc.) based on entry oracle price
  const collateralUnits = totalAssetsUsd / entry.oraclePrice;

  // For ETH-denominated debt: convert initial debt to ETH at entry price.
  // entry.basePrice = ETH/USD at entry block.
  const ethUsdAtEntry = useEthDenom && entry.basePrice > 0 ? entry.basePrice : 1;
  const initialDebtEth = useEthDenom ? initialDebtUsd / ethUsdAtEntry : 0;

  // ── Simulation loop ─────────────────────────────────────────────
  const snapshots: HourlySnapshot[] = [];
  // In USD mode: debtValueUsd is the canonical debt, accrues directly.
  // In ETH mode: debtValueEth is canonical, debtValueUsd derived each step.
  let debtValueUsd = initialDebtUsd;
  let debtValueEth = initialDebtEth;
  let liquidated = false;
  let liquidationTimestamp: number | undefined;
  let peakEquity = startingCapital;
  let maxDrawdown = 0;
  let minHealthFactor = Infinity;
  let minHealthFactorTimestamp = entry.timestamp;
  let totalBorrowApy = 0;

  for (let i = 0; i < series.length; i++) {
    const point = series[i];

    // Accrue interest on debt based on actual time elapsed since last point
    if (i > 0) {
      const prevPoint = series[i - 1];
      const hoursStep = (point.timestamp - prevPoint.timestamp) / 3600;
      const stepRate = point.borrowApy * (hoursStep / 8760);
      if (useEthDenom) {
        debtValueEth = debtValueEth * (1 + stepRate);
      } else {
        debtValueUsd = debtValueUsd * (1 + stepRate);
      }
    }

    // Current collateral value (USD) per oracle
    const collateralValue = collateralUnits * point.oraclePrice;

    // In ETH mode, recompute debt in USD using CURRENT ETH/USD so the USD
    // display tracks ETH price movement but HF remains ratio-based.
    if (useEthDenom) {
      const ethUsdNow = point.basePrice > 0 ? point.basePrice : ethUsdAtEntry;
      debtValueUsd = debtValueEth * ethUsdNow;
    }
    const debtValue = debtValueUsd;

    // Health factor — in ETH mode this simplifies to a pure ratio check
    // since collateralValue and debtValue both scale with ETH/USD.
    const healthFactor =
      debtValue > 0
        ? (collateralValue * liquidationLtv) / debtValue
        : Infinity;

    // Equity
    const equity = collateralValue - debtValue;

    // Returns — use actual elapsed time, not data point count
    const cumulativeReturn = equity / startingCapital - 1;
    const actualHoursElapsed = (point.timestamp - entry.timestamp) / 3600;
    const yearsElapsed = actualHoursElapsed / 8760;
    const annualizedReturn =
      yearsElapsed > 0.01 // avoid extreme annualization for very short periods
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
    totalHours: Math.round((series[series.length - 1].timestamp - entry.timestamp) / 3600),
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
