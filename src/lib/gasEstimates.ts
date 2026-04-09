/**
 * Gas cost estimation for entry/exit loop transactions.
 * Gas units are approximate mainnet averages from empirical data.
 */

// ── Per-action gas estimates ───────────────────────────────────────

export const GAS_UNITS = {
  sUSDS_DEPOSIT_MORPHO: 120_000, // supplyCollateral
  BORROW_MORPHO: 110_000, // borrow
  SWAP_CURVE: 130_000, // exchange on Curve StableSwap
  SWAP_UNISWAP: 120_000, // exactInputSingle on Uni V3
  STAKE_SUSDS: 60_000, // deposit into SavingsRate (Sky)
  FLASH_BALANCER: 80_000, // Balancer flash loan wrapper overhead
  FLASH_MORPHO: 60_000, // Morpho flash loan wrapper overhead
} as const;

/** Gas per manual loop iteration (deposit + borrow + swap + stake) */
export const GAS_PER_LOOP_CURVE =
  GAS_UNITS.sUSDS_DEPOSIT_MORPHO +
  GAS_UNITS.BORROW_MORPHO +
  GAS_UNITS.SWAP_CURVE +
  GAS_UNITS.STAKE_SUSDS; // 420k

export const GAS_PER_LOOP_UNISWAP =
  GAS_UNITS.sUSDS_DEPOSIT_MORPHO +
  GAS_UNITS.BORROW_MORPHO +
  GAS_UNITS.SWAP_UNISWAP +
  GAS_UNITS.STAKE_SUSDS; // 410k

// ── USD conversion ─────────────────────────────────────────────────

/**
 * Convert gas units to USD cost.
 * @param gasUnits Total gas units
 * @param gasPriceGwei Gas price in gwei
 * @param ethUsdPrice Current ETH/USD price
 */
export function gasToUsd(
  gasUnits: number,
  gasPriceGwei: number,
  ethUsdPrice: number
): number {
  return gasUnits * gasPriceGwei * 1e-9 * ethUsdPrice;
}

// ── Loop count formula ─────────────────────────────────────────────

/**
 * Number of manual loop iterations to reach target leverage at given LTV.
 * loops = ceil(ln(1 - leverage * (1 - LTV)) / ln(LTV)) - 1
 */
export function loopCount(leverage: number, ltv: number): number {
  if (leverage <= 1 || ltv <= 0 || ltv >= 1) return 0;
  const num = Math.log(1 - leverage * (1 - ltv));
  const denom = Math.log(ltv);
  if (!isFinite(num) || !isFinite(denom) || denom === 0) return 0;
  return Math.max(1, Math.ceil(num / denom) - 1);
}

/**
 * Per-loop swap amounts (USDT that must be swapped per iteration).
 * swap_i = startingCapital * LTV^(i+1)
 */
export function perLoopSwapAmounts(
  startingCapital: number,
  ltv: number,
  loops: number
): number[] {
  const amounts: number[] = [];
  for (let i = 0; i < loops; i++) {
    amounts.push(startingCapital * Math.pow(ltv, i + 1));
  }
  return amounts;
}

/**
 * Total swap volume = startingCapital * (leverage - 1)
 */
export function totalSwapVolume(
  startingCapital: number,
  leverage: number
): number {
  return startingCapital * (leverage - 1);
}

// ── Gas totals ─────────────────────────────────────────────────────

export interface GasCostBreakdown {
  manualTotal: number; // gas units
  flashBalancerTotal: number; // gas units
  flashMorphoTotal: number; // gas units
}

export function computeGasCosts(
  loops: number,
  venue: "curve" | "uniswap"
): GasCostBreakdown {
  const perLoop =
    venue === "curve" ? GAS_PER_LOOP_CURVE : GAS_PER_LOOP_UNISWAP;
  const manualTotal = perLoop * loops;
  return {
    manualTotal,
    flashBalancerTotal: GAS_UNITS.FLASH_BALANCER + perLoop * loops,
    flashMorphoTotal: GAS_UNITS.FLASH_MORPHO + perLoop * loops,
  };
}
