/**
 * On-chain swap quote fetching for Uniswap V3 and Curve StableSwap.
 * Uses viem readContract for view calls — no gas cost, client-side safe.
 */

import { type PublicClient, parseAbi, formatUnits, getAddress } from "viem";

// ── Contract addresses ─────────────────────────────────────────────

const USDS_ADDRESS = getAddress("0xdC035D45d973E3EC169d2276DDab16f1e407384F");
const USDT_ADDRESS = getAddress("0xdAC17F958D2ee523a2206206994597C13D831ec7");
const UNISWAP_V3_FACTORY = getAddress("0x1F98431c8aD98523631AE4a59f267346ea31F984");
const CURVE_POOL = getAddress("0x00836fE54625bE242bcfA286207795405cA4FD10");

// ── ABIs ───────────────────────────────────────────────────────────

const FACTORY_ABI = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)",
]);

const UNI_POOL_ABI = parseAbi([
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() external view returns (uint128)",
]);

// Curve sUSDS/USDT pool uses legacy int128 ABI
const CURVE_ABI = parseAbi([
  "function get_dy(int128 i, int128 j, uint256 dx) external view returns (uint256)",
  "function coins(uint256 i) external view returns (address)",
]);

// ── Types ──────────────────────────────────────────────────────────

export interface UniswapQuote {
  poolAddress: string;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  effectiveDepthUsd: number;
  feeBps: number;
}

export interface SwapCostResult {
  venue: "curve" | "uniswap";
  feePct: number; // pool fee as decimal (e.g. 0.0001 = 1 bps)
  totalFeeCost: number; // USD from pool fee
  totalSlippageCost: number; // USD from price impact
  totalCost: number; // fee + slippage
  perLoopCosts: number[]; // slippage per loop in USD
  warning?: string;
}

// ── Uniswap V3 ────────────────────────────────────────────────────

/**
 * Resolve the Uniswap V3 USDT/USDS pool address and fetch slot0 + liquidity.
 */
export async function fetchUniswapPoolData(
  client: PublicClient
): Promise<UniswapQuote | null> {
  try {
    // Resolve pool address from factory (0.01% = fee tier 100)
    const poolAddress = await client.readContract({
      address: UNISWAP_V3_FACTORY,
      abi: FACTORY_ABI,
      functionName: "getPool",
      args: [USDT_ADDRESS, USDS_ADDRESS, 100],
    });

    if (!poolAddress || poolAddress === "0x0000000000000000000000000000000000000000") {
      return null;
    }

    const [slot0Result, liquidityResult] = await Promise.all([
      client.readContract({
        address: poolAddress as `0x${string}`,
        abi: UNI_POOL_ABI,
        functionName: "slot0",
      }),
      client.readContract({
        address: poolAddress as `0x${string}`,
        abi: UNI_POOL_ABI,
        functionName: "liquidity",
      }),
    ]);

    const sqrtPriceX96 = (slot0Result as readonly [bigint, number, number, number, number, number, boolean])[0];
    const liquidity = liquidityResult as bigint;

    // Effective depth: D = L * sqrtPrice / 2^96 (in one token's terms)
    // For USDT (6 decimals) vs USDS (18 decimals), adjust accordingly
    const sqrtPriceFloat = Number(sqrtPriceX96) / 2 ** 96;
    const liquidityFloat = Number(liquidity);
    // Depth in USDS units, then convert to USD (~$1)
    const effectiveDepthUsd = (liquidityFloat * sqrtPriceFloat) / 1e12; // adjust for decimal mismatch

    return {
      poolAddress: poolAddress as string,
      sqrtPriceX96,
      liquidity,
      effectiveDepthUsd,
      feeBps: 1, // 0.01% tier
    };
  } catch (err) {
    console.warn("Failed to fetch Uniswap pool data:", (err as Error).message?.slice(0, 100));
    return null;
  }
}

/**
 * Estimate Uniswap V3 swap cost per loop using constant-product price impact approximation.
 * price_impact_pct ≈ Δx / (2 × D)
 */
export function computeUniswapCosts(
  swapAmountsPerLoop: number[],
  poolData: UniswapQuote
): SwapCostResult {
  const feePct = poolData.feeBps / 10_000; // 0.0001 = 1 bps
  let totalFeeCost = 0;
  let totalSlippageCost = 0;
  const perLoopCosts: number[] = [];
  let warning: string | undefined;

  for (const amount of swapAmountsPerLoop) {
    const fee = amount * feePct;
    // Price impact: amount / (2 * depth)
    let impactPct = poolData.effectiveDepthUsd > 0
      ? amount / (2 * poolData.effectiveDepthUsd)
      : 0;
    // Cap at 2% as sanity bound
    if (impactPct > 0.02) {
      impactPct = 0.02;
      warning = "Uniswap pool depth may be insufficient for this size — Curve recommended";
    }
    const slippage = amount * impactPct;
    totalFeeCost += fee;
    totalSlippageCost += slippage;
    perLoopCosts.push(slippage);
  }

  return {
    venue: "uniswap",
    feePct,
    totalFeeCost,
    totalSlippageCost,
    totalCost: totalFeeCost + totalSlippageCost,
    perLoopCosts,
    warning,
  };
}

// ── Curve StableSwap ──────────────────────────────────────────────

/**
 * Fetch Curve sUSDS/USDT pool quotes for each loop.
 * Pool is coin0=sUSDS(18dec), coin1=USDT(6dec), legacy int128 ABI.
 *
 * Cost is computed by comparing each swap's effective rate against the
 * spot rate (derived from a tiny reference swap), so the sUSDS/USDT
 * exchange rate doesn't cause spurious slippage.
 */
export async function fetchCurveCosts(
  client: PublicClient,
  swapAmountsPerLoop: number[],
  direction: "entry" | "exit" = "entry"
): Promise<SwapCostResult> {
  try {
    // Pool: coin0=sUSDS(18dec), coin1=USDT(6dec)
    // Entry: USDT → sUSDS (i=1, j=0). Exit: sUSDS → USDT (i=0, j=1).
    const fromIdx = direction === "entry" ? BigInt(1) : BigInt(0);
    const toIdx = direction === "entry" ? BigInt(0) : BigInt(1);
    const fromDecimals = direction === "entry" ? 6 : 18; // USDT : sUSDS
    const toDecimals = direction === "entry" ? 18 : 6; // sUSDS : USDT

    // 1. Get spot rate from a small reference swap ($10)
    const refDx = BigInt(Math.round(10 * 10 ** fromDecimals));
    const refDy = await client.readContract({
      address: CURVE_POOL,
      abi: CURVE_ABI,
      functionName: "get_dy",
      args: [fromIdx, toIdx, refDx],
    }) as bigint;
    // spotRate = output_units / input_units (at near-zero size, includes fee but negligible slippage)
    const spotRate = Number(refDy) / Number(refDx);

    // 2. For each loop, compare actual output vs expected at spot rate
    const CURVE_FEE_PCT = 0.0004; // 0.04%
    const perLoopCosts: number[] = [];
    let totalSlippageCost = 0;
    let totalFeeCost = 0;
    let fallback = false;

    const dyResults = await Promise.all(
      swapAmountsPerLoop.map(async (amountUsd) => {
        const dx = BigInt(Math.round(amountUsd * 10 ** fromDecimals));
        try {
          const dy = await client.readContract({
            address: CURVE_POOL,
            abi: CURVE_ABI,
            functionName: "get_dy",
            args: [fromIdx, toIdx, dx],
          });
          return { amountUsd, dx, dy: dy as bigint, success: true };
        } catch {
          return { amountUsd, dx, dy: BigInt(0), success: false };
        }
      })
    );

    for (const { amountUsd, dx, dy, success } of dyResults) {
      if (!success || dy === BigInt(0)) {
        fallback = true;
        const cost = amountUsd * CURVE_FEE_PCT;
        perLoopCosts.push(cost);
        totalSlippageCost += cost;
        totalFeeCost += amountUsd * CURVE_FEE_PCT;
        continue;
      }

      // Expected output at spot rate
      const expectedDy = Number(dx) * spotRate;
      const actualDy = Number(dy);
      // Total cost in output token units, then convert to USD
      const lostUnits = expectedDy - actualDy;
      // Convert lost units to USD: lost_units / (10^toDecimals) * (amountUsd / (actualDy / 10^toDecimals))
      // Simplified: totalCostUsd = (lostUnits / actualDy) * amountUsd
      const totalCostUsd = actualDy > 0 ? (lostUnits / actualDy) * amountUsd : amountUsd * CURVE_FEE_PCT;

      // Fee is embedded in get_dy output; spot rate already includes fee on $10
      // So most of totalCostUsd is pure price impact (slippage)
      const fee = amountUsd * CURVE_FEE_PCT;
      const slippage = Math.max(0, totalCostUsd);

      perLoopCosts.push(slippage);
      totalSlippageCost += slippage;
      totalFeeCost += fee;
    }

    return {
      venue: "curve",
      feePct: CURVE_FEE_PCT,
      totalFeeCost,
      totalSlippageCost,
      totalCost: totalFeeCost + totalSlippageCost,
      perLoopCosts,
      warning: fallback
        ? "Some Curve get_dy calls failed — using flat 0.04% fee estimate"
        : undefined,
    };
  } catch (err) {
    console.warn("Failed to fetch Curve costs:", (err as Error).message?.slice(0, 100));
    // Full fallback
    const CURVE_FEE_PCT = 0.0004;
    const totalVolume = swapAmountsPerLoop.reduce((s, a) => s + a, 0);
    return {
      venue: "curve",
      feePct: CURVE_FEE_PCT,
      totalFeeCost: totalVolume * CURVE_FEE_PCT,
      totalSlippageCost: 0,
      totalCost: totalVolume * CURVE_FEE_PCT,
      perLoopCosts: swapAmountsPerLoop.map((a) => a * CURVE_FEE_PCT),
      warning: "Curve pool unavailable — using flat 0.04% fee estimate",
    };
  }
}

// ── Comparison helper ─────────────────────────────────────────────

export interface VenueComparison {
  curve: SwapCostResult;
  uniswap: SwapCostResult | null;
  recommended: "curve" | "uniswap";
  savingBps: number; // how much cheaper the recommended venue is
}

/**
 * Compare Curve vs Uniswap and recommend the cheaper venue.
 * Default: Curve unless Uniswap is cheaper by more than 2 bps.
 */
export function compareVenues(
  curve: SwapCostResult,
  uniswap: SwapCostResult | null,
  totalVolume: number
): VenueComparison {
  if (!uniswap) {
    return { curve, uniswap: null, recommended: "curve", savingBps: 0 };
  }

  const curveBps = totalVolume > 0 ? (curve.totalCost / totalVolume) * 10_000 : 0;
  const uniBps = totalVolume > 0 ? (uniswap.totalCost / totalVolume) * 10_000 : 0;
  const diff = curveBps - uniBps;

  // Recommend Uniswap only if cheaper by > 2 bps
  if (diff > 2) {
    return { curve, uniswap, recommended: "uniswap", savingBps: diff };
  }
  return { curve, uniswap, recommended: "curve", savingBps: -diff };
}
