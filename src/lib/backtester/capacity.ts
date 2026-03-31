/**
 * Capacity analysis: determine maximum strategy size
 * without significantly impacting market dynamics.
 *
 * Uses Morpho Adaptive Curve IRM to model how borrow rates
 * change as strategy size increases utilization.
 */

import type { CapacityConfig, CapacityPoint, CapacityResult } from "./types";
import { morphoBorrowApy } from "../irm";

/**
 * Sweep strategy size and calculate impact on borrow rates and net APY.
 *
 * For each size:
 * 1. Calculate additional debt = startingCapital × (leverage - 1)
 * 2. Compute new utilization = (currentBorrow + additionalDebt) / currentSupply
 * 3. Use Morpho IRM to get new borrow APY
 * 4. Calculate net APY = collateralAPY × leverage - borrowAPY × (leverage - 1)
 */
export function runCapacityAnalysis(
  config: CapacityConfig,
  collateralApy: number, // decimal, e.g., 0.065 = 6.5%
  sizeSteps?: number[]
): CapacityResult {
  const {
    leverage,
    currentSupplyUsd,
    currentBorrowUsd,
    apyAtTarget,
  } = config;

  // Default size steps: $10K to $100M in geometric progression
  const sizes = sizeSteps ?? generateSizeSteps(10_000, 100_000_000, 40);

  const currentUtilization =
    currentSupplyUsd > 0 ? currentBorrowUsd / currentSupplyUsd : 0;
  const currentBorrowRate = morphoBorrowApy(currentUtilization, apyAtTarget);

  const points: CapacityPoint[] = [];
  let optimalSize = sizes[0];
  let breakEvenSize = sizes[sizes.length - 1];
  let maxSafeSize = sizes[sizes.length - 1];
  let bestNetApy = -Infinity;

  for (const capitalUsd of sizes) {
    const additionalDebtUsd = capitalUsd * (leverage - 1);
    const newBorrowTotal = currentBorrowUsd + additionalDebtUsd;
    const newUtilization =
      currentSupplyUsd > 0
        ? Math.min(newBorrowTotal / currentSupplyUsd, 0.999)
        : 0;

    const estimatedBorrowApy = morphoBorrowApy(newUtilization, apyAtTarget);

    // Net APY: collateral yield × leverage - borrow cost × (leverage - 1)
    // Divided by starting capital → already per unit of capital
    const netApy =
      collateralApy * leverage - estimatedBorrowApy * (leverage - 1);

    const utilizationImpact = newUtilization - currentUtilization;

    points.push({
      capitalUsd,
      additionalDebtUsd,
      newUtilization,
      estimatedBorrowApy,
      netApy,
      utilizationImpact,
    });

    // Track optimal (best net APY)
    if (netApy > bestNetApy) {
      bestNetApy = netApy;
      optimalSize = capitalUsd;
    }

    // Track break-even (first time net APY <= 0)
    if (netApy <= 0 && capitalUsd < breakEvenSize) {
      breakEvenSize = capitalUsd;
    }

    // Track max safe (utilization stays < 95%)
    if (newUtilization >= 0.95 && capitalUsd < maxSafeSize) {
      maxSafeSize = capitalUsd;
    }
  }

  return {
    points,
    optimalSize,
    breakEvenSize,
    maxSafeSize,
  };
}

/**
 * Generate logarithmically-spaced size steps.
 */
function generateSizeSteps(
  min: number,
  max: number,
  count: number
): number[] {
  const logMin = Math.log10(min);
  const logMax = Math.log10(max);
  const step = (logMax - logMin) / (count - 1);

  const steps: number[] = [];
  for (let i = 0; i < count; i++) {
    steps.push(Math.round(Math.pow(10, logMin + step * i)));
  }
  return steps;
}
