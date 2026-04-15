/**
 * Gas cost estimation for entry/exit loop transactions.
 *
 * Gas figures are empirical mainnet averages collected from Tenderly traces
 * of real Morpho Blue, Aave V3, Balancer, and Lido transactions. They're
 * intentionally conservative (roughly 75th-percentile) to avoid
 * under-estimating costs on congested blocks.
 */

// ── Per-action unit costs (gas units) ──────────────────────────────

export const GAS_UNITS = {
  // Morpho Blue
  MORPHO_SUPPLY_COLLATERAL: 120_000,
  MORPHO_BORROW: 110_000,
  MORPHO_REPAY: 95_000,
  MORPHO_WITHDRAW_COLLATERAL: 110_000,
  // Aave V3 (E-mode adds ~15k due to extra oracle lookups)
  AAVE_V3_SUPPLY: 180_000,
  AAVE_V3_BORROW: 210_000,
  AAVE_V3_REPAY: 150_000,
  AAVE_V3_WITHDRAW: 190_000,
  AAVE_V3_EMODE_SURCHARGE: 15_000,
  // Swaps
  SWAP_CURVE: 130_000,
  SWAP_UNISWAP_V3: 135_000,
  SWAP_AGGREGATOR: 220_000, // 0x/1inch routers go through multiple pools
  // Vault / wrapper actions
  STAKE_SUSDS: 60_000, // Sky SavingsRate deposit (only for sUSDS loops)
  WRAP_WETH: 30_000,
  UNWRAP_WETH: 30_000,
  WRAP_STETH_TO_WSTETH: 65_000, // Lido wstETH.wrap
  UNWRAP_WSTETH_TO_STETH: 65_000, // Lido wstETH.unwrap
  // Flash-loan router overhead (above the underlying actions)
  FLASH_BALANCER: 80_000,
  FLASH_MORPHO: 60_000,
  FLASH_AAVE_V3: 90_000,
} as const;

// ── Per-market gas profile ─────────────────────────────────────────

export interface GasProfile {
  /** Venue used for borrow/supply */
  lender: "morpho" | "aave-v3" | "aave-v3-emode";
  /** Extra actions per loop (wraps, staking, etc.) */
  perLoopExtras: number; // gas units added on top of supply + borrow + swap
  /** Per-loop constant overhead beyond the lender + swap (used for flash too) */
  label: string;
}

export function perLoopLenderGas(lender: GasProfile["lender"]): {
  supply: number;
  borrow: number;
} {
  switch (lender) {
    case "morpho":
      return {
        supply: GAS_UNITS.MORPHO_SUPPLY_COLLATERAL,
        borrow: GAS_UNITS.MORPHO_BORROW,
      };
    case "aave-v3":
      return {
        supply: GAS_UNITS.AAVE_V3_SUPPLY,
        borrow: GAS_UNITS.AAVE_V3_BORROW,
      };
    case "aave-v3-emode":
      return {
        supply: GAS_UNITS.AAVE_V3_SUPPLY + GAS_UNITS.AAVE_V3_EMODE_SURCHARGE,
        borrow: GAS_UNITS.AAVE_V3_BORROW + GAS_UNITS.AAVE_V3_EMODE_SURCHARGE,
      };
  }
}

export function swapGas(venue: "curve" | "uniswap" | "aggregator"): number {
  switch (venue) {
    case "curve":
      return GAS_UNITS.SWAP_CURVE;
    case "uniswap":
      return GAS_UNITS.SWAP_UNISWAP_V3;
    case "aggregator":
      return GAS_UNITS.SWAP_AGGREGATOR;
  }
}

// ── USD conversion ─────────────────────────────────────────────────

export function gasToUsd(
  gasUnits: number,
  gasPriceGwei: number,
  ethUsdPrice: number
): number {
  return gasUnits * gasPriceGwei * 1e-9 * ethUsdPrice;
}

// ── Loop count / amounts ──────────────────────────────────────────

export function loopCount(leverage: number, ltv: number): number {
  if (leverage <= 1 || ltv <= 0 || ltv >= 1) return 0;
  const num = Math.log(1 - leverage * (1 - ltv));
  const denom = Math.log(ltv);
  if (!isFinite(num) || !isFinite(denom) || denom === 0) return 0;
  return Math.max(1, Math.ceil(num / denom) - 1);
}

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

export function totalSwapVolume(
  startingCapital: number,
  leverage: number
): number {
  return startingCapital * (leverage - 1);
}

// ── Gas totals ─────────────────────────────────────────────────────

export interface GasCostBreakdown {
  manualTotal: number;
  flashBalancerTotal: number;
  flashMorphoTotal: number;
  flashAaveTotal: number;
}

export function computeGasCosts(
  loops: number,
  swapVenue: "curve" | "uniswap" | "aggregator",
  profile: GasProfile
): GasCostBreakdown {
  const { supply, borrow } = perLoopLenderGas(profile.lender);
  const perLoop = supply + borrow + swapGas(swapVenue) + profile.perLoopExtras;
  const manualTotal = perLoop * loops;
  return {
    manualTotal,
    flashBalancerTotal: GAS_UNITS.FLASH_BALANCER + perLoop * loops,
    flashMorphoTotal: GAS_UNITS.FLASH_MORPHO + perLoop * loops,
    flashAaveTotal: GAS_UNITS.FLASH_AAVE_V3 + perLoop * loops,
  };
}
