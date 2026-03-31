/**
 * Parameter optimization via grid search.
 * Sweeps LTV × leverage space and runs backtests for each combination.
 */

import type {
  BacktestConfig,
  HourlyDataPoint,
  OptimizationPoint,
  OptimizationResult,
} from "./types";
import { runBacktest } from "./engine";

/**
 * Run grid search optimization over LTV and leverage parameters.
 *
 * LTV range: from ltvMin to just below liquidationLtv
 * Leverage range: from 1.5x to max leverage for each LTV
 * Max leverage for a given LTV = 1 / (1 - LTV)
 */
export function runOptimization(
  baseConfig: Omit<BacktestConfig, "ltv" | "leverage">,
  data: HourlyDataPoint[],
  options?: {
    ltvMin?: number;
    ltvMax?: number;
    ltvStep?: number;
    leverageMin?: number;
    leverageMax?: number;
    leverageStep?: number;
  }
): OptimizationResult {
  const ltvMin = options?.ltvMin ?? 0.5;
  const ltvMax = options?.ltvMax ?? baseConfig.liquidationLtv - 0.025;
  const ltvStep = options?.ltvStep ?? 0.025;
  const leverageMin = options?.leverageMin ?? 1.5;
  const leverageMaxCap = options?.leverageMax ?? 10;
  const leverageStep = options?.leverageStep ?? 0.5;

  const points: OptimizationPoint[] = [];

  for (let ltv = ltvMin; ltv <= ltvMax; ltv += ltvStep) {
    // Max leverage for this LTV: 1 / (1 - LTV)
    const maxLeverage = Math.min(1 / (1 - ltv), leverageMaxCap);

    for (
      let leverage = leverageMin;
      leverage <= maxLeverage;
      leverage += leverageStep
    ) {
      const config: BacktestConfig = {
        ...baseConfig,
        ltv,
        leverage,
      };

      try {
        const result = runBacktest(config, data);
        points.push({
          ltv: Math.round(ltv * 1000) / 1000,
          leverage: Math.round(leverage * 100) / 100,
          annualizedReturn: result.annualizedReturn,
          maxDrawdown: result.maxDrawdown,
          minHealthFactor: result.minHealthFactor,
          liquidated: result.liquidated,
        });
      } catch {
        // Skip invalid combinations
        continue;
      }
    }
  }

  // Find optimal: best return among non-liquidated strategies
  // with a minimum health factor buffer (> 1.05)
  const safePoints = points.filter(
    (p) => !p.liquidated && p.minHealthFactor > 1.05
  );
  const optimal =
    safePoints.length > 0
      ? safePoints.reduce((best, p) =>
          p.annualizedReturn > best.annualizedReturn ? p : best
        )
      : null;

  return {
    points,
    optimal,
    ltvRange: [ltvMin, ltvMax],
    leverageRange: [leverageMin, leverageMaxCap],
  };
}
