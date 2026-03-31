/**
 * Exit signal framework.
 * Defines trigger conditions and backtests them against historical data.
 */

import type {
  ExitSignal,
  ExitSignalType,
  ExitAnalysisResult,
  HourlySnapshot,
} from "./types";

interface SignalDefinition {
  type: ExitSignalType;
  label: string;
  description: string;
  threshold: number;
  evaluate: (
    snapshot: HourlySnapshot,
    context: SignalContext
  ) => boolean;
}

interface SignalContext {
  collateralApy: number; // avg collateral APY (decimal)
  avgBorrowApy: number; // rolling average borrow APY
  prevSnapshot?: HourlySnapshot;
  oraclePrice24hAgo?: number;
}

/**
 * Define all exit signals with their thresholds and evaluation logic.
 */
function getSignalDefinitions(
  collateralApy: number,
  liquidationLtv: number
): SignalDefinition[] {
  return [
    {
      type: "negative_carry",
      label: "Negative Carry",
      description:
        "Borrow APY exceeds collateral APY — strategy is losing money on each marginal dollar",
      threshold: collateralApy,
      evaluate: (snap, ctx) => snap.borrowApy > ctx.collateralApy,
    },
    {
      type: "health_warning",
      label: "Health Factor Warning",
      description: `Health factor drops below 1.30 (LLTV: ${(liquidationLtv * 100).toFixed(0)}%) — approaching liquidation zone`,
      threshold: 1.3,
      evaluate: (snap) => snap.healthFactor < 1.3 && snap.healthFactor > 0,
    },
    {
      type: "rate_spike",
      label: "Borrow Rate Spike",
      description:
        "Borrow APY exceeds 2× its rolling average — abnormal market conditions",
      threshold: 2.0,
      evaluate: (snap, ctx) =>
        ctx.avgBorrowApy > 0 && snap.borrowApy > ctx.avgBorrowApy * 2,
    },
    {
      type: "spread_compression",
      label: "Spread Compression",
      description:
        "Net APY (collateral yield minus borrow cost at leverage) drops below 1% — insufficient return for risk",
      threshold: 0.01,
      evaluate: (snap, ctx) => {
        // Estimate net APY at this point
        const leverage =
          snap.collateralValue > 0
            ? snap.collateralValue / (snap.collateralValue - snap.debtValue)
            : 1;
        const netApy =
          ctx.collateralApy * leverage - snap.borrowApy * (leverage - 1);
        return netApy < 0.01;
      },
    },
    {
      type: "depeg_alert",
      label: "Collateral Depeg Alert",
      description:
        "Oracle price drops more than 0.5% in 24 hours — potential collateral devaluation",
      threshold: 0.005,
      evaluate: (snap, ctx) => {
        if (!ctx.oraclePrice24hAgo || ctx.oraclePrice24hAgo === 0)
          return false;
        const pctChange =
          (ctx.oraclePrice24hAgo - snap.oraclePrice) / ctx.oraclePrice24hAgo;
        return pctChange > 0.005;
      },
    },
  ];
}

/**
 * Run exit signal analysis against backtest snapshots.
 */
export function analyzeExitSignals(
  snapshots: HourlySnapshot[],
  collateralApy: number,
  liquidationLtv: number
): ExitAnalysisResult {
  if (snapshots.length === 0) {
    return { signals: [], collateralApy };
  }

  const definitions = getSignalDefinitions(collateralApy, liquidationLtv);

  // Rolling window for average borrow APY (24h = 24 hourly points)
  const ROLLING_WINDOW = 24;
  const borrowApyWindow: number[] = [];

  // Find liquidation timestamp if any
  const liquidationTs = snapshots.find((s) => s.healthFactor < 1.0)?.timestamp;

  const results: Map<
    ExitSignalType,
    { timestamps: number[]; returns: number[] }
  > = new Map();

  for (const def of definitions) {
    results.set(def.type, { timestamps: [], returns: [] });
  }

  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i];

    // Maintain rolling borrow APY average
    borrowApyWindow.push(snap.borrowApy);
    if (borrowApyWindow.length > ROLLING_WINDOW) {
      borrowApyWindow.shift();
    }
    const avgBorrowApy =
      borrowApyWindow.reduce((a, b) => a + b, 0) / borrowApyWindow.length;

    // 24h-ago price for depeg detection
    const oraclePrice24hAgo =
      i >= 24 ? snapshots[i - 24].oraclePrice : undefined;

    const context: SignalContext = {
      collateralApy,
      avgBorrowApy,
      prevSnapshot: i > 0 ? snapshots[i - 1] : undefined,
      oraclePrice24hAgo,
    };

    for (const def of definitions) {
      if (def.evaluate(snap, context)) {
        const r = results.get(def.type)!;
        r.timestamps.push(snap.timestamp);
        r.returns.push(snap.cumulativeReturn);
      }
    }
  }

  const signals: ExitSignal[] = definitions.map((def) => {
    const r = results.get(def.type)!;
    const avgReturn =
      r.returns.length > 0
        ? r.returns.reduce((a, b) => a + b, 0) / r.returns.length
        : 0;

    const wouldHaveExited =
      r.timestamps.length > 0 && liquidationTs
        ? r.timestamps[0] < liquidationTs
        : false;

    return {
      type: def.type,
      label: def.label,
      description: def.description,
      threshold: def.threshold,
      triggerCount: r.timestamps.length,
      triggerTimestamps: r.timestamps.slice(0, 100), // limit stored timestamps
      wouldHaveExited,
      avgReturnAtTrigger: avgReturn,
    };
  });

  return { signals, collateralApy };
}
