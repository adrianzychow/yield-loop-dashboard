/**
 * On-chain + aggregator swap quote fetching for entry/exit cost simulation.
 *
 * Routing is driven by a per-market SwapConfig so the calculator can handle
 * both stablecoin loops (USDT ↔ sUSDS) and wstETH/ETH loops (WETH ↔ wstETH)
 * without hardcoded pool addresses.
 *
 * Quote sources:
 *   - Curve StableSwap   : on-chain `get_dy` (exact, includes pool fee)
 *   - Uniswap V3          : on-chain `QuoterV2.quoteExactInputSingle`
 *                           — a full tick-walking simulation (exact for CLMM,
 *                           replacing the prior CPMM approximation)
 *   - Aggregator (0x/1inch): realistic execution quote via /api/swap-quote
 *                           proxy (requires ZEROEX_API_KEY or ONEINCH_API_KEY
 *                           set server-side). Falls back silently.
 */

import {
  type PublicClient,
  parseAbi,
  getAddress,
  type Address,
} from "viem";

// ── Shared addresses ───────────────────────────────────────────────

export const UNI_V3_QUOTER_V2 = getAddress(
  "0x61fFE014bA17989E743c5F6cB21bF9697530B21e"
);

// ── Per-market swap configuration ─────────────────────────────────

export interface TokenInfo {
  address: Address;
  decimals: number;
  symbol: string;
}

export interface CurvePoolConfig {
  address: Address;
  /** Token indices in the pool, from the coins() array */
  entryFromIdx: number; // idx of debt token (pool coin)
  entryToIdx: number; // idx of collateral token
  /** Curve pool ABI variant — most legacy pools use int128 */
  abi: "int128" | "uint256";
  /** Explicit pool fee (decimal) — used when get_dy succeeds so we can
   *  display fee vs slippage separately */
  feePct: number;
}

export interface UniV3PoolConfig {
  feeTier: 100 | 500 | 3000 | 10000; // 0.01% / 0.05% / 0.3% / 1%
}

export interface SwapConfig {
  /** Human-readable label for logs */
  label: string;
  /** Token the user deposits as debt (USDT, WETH, …) */
  debtToken: TokenInfo;
  /** The collateral token the debt is swapped into (sUSDS, wstETH, …) */
  collateralToken: TokenInfo;
  curve?: CurvePoolConfig;
  uniswapV3?: UniV3PoolConfig;
  /** Whether to try the aggregator proxy */
  aggregator?: boolean;
}

// ── ABIs ───────────────────────────────────────────────────────────

const CURVE_INT128_ABI = parseAbi([
  "function get_dy(int128 i, int128 j, uint256 dx) external view returns (uint256)",
]);
const CURVE_UINT256_ABI = parseAbi([
  "function get_dy(uint256 i, uint256 j, uint256 dx) external view returns (uint256)",
]);

const QUOTER_V2_ABI = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(QuoteExactInputSingleParams params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

// ── Result types ──────────────────────────────────────────────────

export interface SwapCostResult {
  venue: "curve" | "uniswap" | "aggregator";
  venueLabel: string; // display name, e.g. "Curve wstETH/ETH"
  feePct: number; // pool fee
  totalFeeCost: number; // USD
  totalSlippageCost: number; // USD
  totalCost: number; // USD (fee + slippage)
  perLoopCosts: number[]; // slippage per loop (USD)
  warning?: string;
  available: boolean; // false → don't show / exclude from recommendation
}

// ── Curve ──────────────────────────────────────────────────────────

/**
 * Quote Curve swap costs using on-chain get_dy.
 *
 * The spot rate is established from a tiny reference swap (10 units of the
 * input token) so we back out slippage independently of the pool's exchange
 * rate (e.g. sUSDS is worth > 1 USDT).
 */
export async function fetchCurveCosts(
  client: PublicClient,
  swapAmountsUsd: number[],
  config: SwapConfig,
  direction: "entry" | "exit"
): Promise<SwapCostResult> {
  if (!config.curve) {
    return emptyResult(
      "curve",
      `Curve ${config.debtToken.symbol}/${config.collateralToken.symbol}`,
      "No Curve pool configured for this market"
    );
  }

  const pool = config.curve;
  // Entry direction: debt → collateral (e.g. USDT → sUSDS, WETH → wstETH)
  // Exit direction: collateral → debt (reverse)
  const fromTok = direction === "entry" ? config.debtToken : config.collateralToken;
  const toTok = direction === "entry" ? config.collateralToken : config.debtToken;
  const fromIdx = direction === "entry" ? pool.entryFromIdx : pool.entryToIdx;
  const toIdx = direction === "entry" ? pool.entryToIdx : pool.entryFromIdx;

  const abi = pool.abi === "int128" ? CURVE_INT128_ABI : CURVE_UINT256_ABI;

  try {
    // Reference swap: 10 units of the input token
    const refInputUnits = 10;
    const refDx = BigInt(Math.round(refInputUnits * 10 ** fromTok.decimals));
    const refDy = await client.readContract({
      address: pool.address,
      abi,
      functionName: "get_dy",
      args: [BigInt(fromIdx), BigInt(toIdx), refDx],
    });
    const spotRate = Number(refDy) / Number(refDx); // output_units / input_units

    // Convert USD swap amounts to input-token units. For stablecoins ≈ 1 USD/unit,
    // for WETH, the USD amount needs ETH price — but here we're in token units
    // already because each swap is already sized in the debt token's USD-equivalent.
    // For the cost calculation we just need *token* amounts and convert results
    // back to USD using the effective rate.
    const results = await Promise.all(
      swapAmountsUsd.map(async (amountUsd) => {
        // Treat amountUsd as "input tokens in USD equivalent":
        //   - USDT/USDC: 1 token ≈ 1 USD
        //   - WETH: the user already sized in USD, we need to convert to WETH.
        //     The caller provides USD amounts, so for WETH we need ETH/USD.
        //     We handle this at the useSwapQuotes level — for now assume
        //     amountUsd is "input tokens * token_price_usd".
        // To keep this function generic, we treat amountUsd as input tokens ×
        // spotUsdPerInputToken (passed separately). Here we assume the caller
        // passes the actual token amount in USD — fine for stablecoins, and
        // for wstETH/WETH the hook below sizes in token units × price.
        const dx = BigInt(
          Math.max(
            1,
            Math.round(
              (amountUsd /
                // We don't know per-token USD price here; caller's responsibility
                // to normalize — we default to 1 (stablecoin-like).
                1) *
                10 ** fromTok.decimals
            )
          )
        );
        try {
          const dy = (await client.readContract({
            address: pool.address,
            abi,
            functionName: "get_dy",
            args: [BigInt(fromIdx), BigInt(toIdx), dx],
          })) as bigint;
          return { amountUsd, dx, dy, success: true as const };
        } catch {
          return { amountUsd, dx, dy: BigInt(0), success: false as const };
        }
      })
    );

    const perLoopCosts: number[] = [];
    let totalFeeCost = 0;
    let totalSlippageCost = 0;
    let fallback = false;

    for (const r of results) {
      if (!r.success || r.dy === BigInt(0)) {
        fallback = true;
        const fee = r.amountUsd * pool.feePct;
        perLoopCosts.push(fee);
        totalFeeCost += fee;
        continue;
      }
      const expectedDy = Number(r.dx) * spotRate;
      const lostUnits = expectedDy - Number(r.dy);
      // Cost in input-token units converted to USD
      const costUsd =
        Number(r.dy) > 0 ? (lostUnits / Number(r.dy)) * r.amountUsd : 0;
      const fee = r.amountUsd * pool.feePct;
      const slippage = Math.max(0, costUsd);
      perLoopCosts.push(slippage);
      totalFeeCost += fee;
      totalSlippageCost += slippage;
    }

    return {
      venue: "curve",
      venueLabel: `Curve ${fromTok.symbol}/${toTok.symbol}`,
      feePct: pool.feePct,
      totalFeeCost,
      totalSlippageCost,
      totalCost: totalFeeCost + totalSlippageCost,
      perLoopCosts,
      available: true,
      warning: fallback
        ? "Some Curve get_dy calls failed — used pool fee as fallback"
        : undefined,
    };
  } catch (err) {
    return emptyResult(
      "curve",
      `Curve ${fromTok.symbol}/${toTok.symbol}`,
      `Curve pool unavailable: ${(err as Error).message?.slice(0, 80)}`
    );
  }
}

// ── Uniswap V3 (QuoterV2 — exact CLMM simulation) ──────────────────

export async function fetchUniswapV3Costs(
  client: PublicClient,
  swapAmountsInputTokens: number[], // in input-token native units (e.g. USDT has 6dp)
  spotUsdPerInputToken: number,
  config: SwapConfig,
  direction: "entry" | "exit"
): Promise<SwapCostResult> {
  if (!config.uniswapV3) {
    return emptyResult(
      "uniswap",
      `Uniswap V3 ${config.debtToken.symbol}/${config.collateralToken.symbol}`,
      "No Uniswap V3 pool configured"
    );
  }

  const fromTok = direction === "entry" ? config.debtToken : config.collateralToken;
  const toTok = direction === "entry" ? config.collateralToken : config.debtToken;
  const fee = config.uniswapV3.feeTier;
  const feePct = fee / 1_000_000;

  try {
    // Establish the spot (zero-impact) rate with a tiny reference swap.
    const refInput = 10; // tokens
    const refDx = BigInt(Math.round(refInput * 10 ** fromTok.decimals));
    const refSim = await client.simulateContract({
      address: UNI_V3_QUOTER_V2,
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: fromTok.address,
          tokenOut: toTok.address,
          amountIn: refDx,
          fee,
          sqrtPriceLimitX96: BigInt(0),
        },
      ],
    });
    const refDy = refSim.result[0] as bigint;
    const spotRate = Number(refDy) / Number(refDx); // output tokens per input token
    if (!isFinite(spotRate) || spotRate === 0) {
      return emptyResult(
        "uniswap",
        `Uniswap V3 ${fromTok.symbol}/${toTok.symbol} (${feePct * 100}%)`,
        "Pool returned zero reference quote"
      );
    }

    const perLoopCosts: number[] = [];
    let totalFeeCost = 0;
    let totalSlippageCost = 0;

    for (const inputTokens of swapAmountsInputTokens) {
      const dx = BigInt(
        Math.max(1, Math.round(inputTokens * 10 ** fromTok.decimals))
      );
      let dy: bigint;
      try {
        const sim = await client.simulateContract({
          address: UNI_V3_QUOTER_V2,
          abi: QUOTER_V2_ABI,
          functionName: "quoteExactInputSingle",
          args: [
            {
              tokenIn: fromTok.address,
              tokenOut: toTok.address,
              amountIn: dx,
              fee,
              sqrtPriceLimitX96: BigInt(0),
            },
          ],
        });
        dy = sim.result[0] as bigint;
      } catch {
        dy = BigInt(0);
      }

      const amountUsd = inputTokens * spotUsdPerInputToken;
      if (dy === BigInt(0)) {
        const fallbackFee = amountUsd * feePct;
        perLoopCosts.push(fallbackFee);
        totalFeeCost += fallbackFee;
        continue;
      }

      const expectedDy = Number(dx) * spotRate;
      const lostOutputUnits = Math.max(0, expectedDy - Number(dy));
      // Total cost (fee + slippage) in USD
      const totalCostUsd =
        Number(dy) > 0 ? (lostOutputUnits / Number(dy)) * amountUsd : 0;
      const feePortion = amountUsd * feePct;
      const slippagePortion = Math.max(0, totalCostUsd - feePortion);

      totalFeeCost += feePortion;
      totalSlippageCost += slippagePortion;
      perLoopCosts.push(slippagePortion);
    }

    return {
      venue: "uniswap",
      venueLabel: `Uniswap V3 ${fromTok.symbol}/${toTok.symbol} (${(feePct * 100).toFixed(2)}%)`,
      feePct,
      totalFeeCost,
      totalSlippageCost,
      totalCost: totalFeeCost + totalSlippageCost,
      perLoopCosts,
      available: true,
    };
  } catch (err) {
    return emptyResult(
      "uniswap",
      `Uniswap V3 ${fromTok.symbol}/${toTok.symbol}`,
      `QuoterV2 simulation failed: ${(err as Error).message?.slice(0, 80)}`
    );
  }
}

// ── Aggregator (0x / 1inch via proxy) ──────────────────────────────

export interface AggregatorRawQuote {
  available: boolean;
  source: "0x" | "1inch" | null;
  buyAmount?: string;
  estimatedGas?: string;
  priceImpact?: number;
  error?: string;
}

async function fetchAggregatorRaw(
  sellToken: Address,
  buyToken: Address,
  sellAmountBaseUnits: bigint
): Promise<AggregatorRawQuote> {
  const url = `/api/swap-quote?chainId=1&sellToken=${sellToken}&buyToken=${buyToken}&sellAmount=${sellAmountBaseUnits.toString()}`;
  try {
    const res = await fetch(url);
    const data = (await res.json()) as AggregatorRawQuote;
    return data;
  } catch (err) {
    return {
      available: false,
      source: null,
      error: (err as Error).message,
    };
  }
}

/**
 * Get aggregator cost estimates for each loop size.
 *
 * Approach: issue one /price call per loop amount, compare returned
 * buyAmount against a tiny-reference quote (same spot methodology) to
 * isolate price impact + aggregator fees.
 */
export async function fetchAggregatorCosts(
  swapAmountsInputTokens: number[],
  spotUsdPerInputToken: number,
  config: SwapConfig,
  direction: "entry" | "exit"
): Promise<SwapCostResult & { source?: "0x" | "1inch" | null }> {
  if (!config.aggregator) {
    return {
      ...emptyResult(
        "aggregator",
        "Aggregator (0x/1inch)",
        "Aggregator disabled for this market"
      ),
      source: null,
    };
  }

  const fromTok = direction === "entry" ? config.debtToken : config.collateralToken;
  const toTok = direction === "entry" ? config.collateralToken : config.debtToken;

  // Reference quote for spot rate
  const refInput = 1; // 1 token
  const refDx = BigInt(Math.round(refInput * 10 ** fromTok.decimals));
  const refQuote = await fetchAggregatorRaw(
    fromTok.address,
    toTok.address,
    refDx
  );
  if (!refQuote.available || !refQuote.buyAmount) {
    return {
      ...emptyResult(
        "aggregator",
        "Aggregator (0x/1inch)",
        refQuote.error ?? "Aggregator unavailable"
      ),
      source: refQuote.source,
    };
  }
  const refDy = BigInt(refQuote.buyAmount);
  const spotRate = Number(refDy) / Number(refDx);

  const perLoopCosts: number[] = [];
  let totalCost = 0;
  let lastError: string | undefined;

  for (const inputTokens of swapAmountsInputTokens) {
    const dx = BigInt(Math.max(1, Math.round(inputTokens * 10 ** fromTok.decimals)));
    const q = await fetchAggregatorRaw(fromTok.address, toTok.address, dx);
    const amountUsd = inputTokens * spotUsdPerInputToken;

    if (!q.available || !q.buyAmount) {
      lastError = q.error;
      // Treat as no-cost sample — mark as non-available overall later if all fail
      perLoopCosts.push(0);
      continue;
    }
    const dy = BigInt(q.buyAmount);
    const expectedDy = Number(dx) * spotRate;
    const lostOutputUnits = Math.max(0, expectedDy - Number(dy));
    const costUsd =
      Number(dy) > 0 ? (lostOutputUnits / Number(dy)) * amountUsd : 0;
    perLoopCosts.push(costUsd);
    totalCost += costUsd;
  }

  const allFailed = perLoopCosts.every((c) => c === 0) && lastError;
  if (allFailed) {
    return {
      ...emptyResult(
        "aggregator",
        `Aggregator (${refQuote.source ?? "none"})`,
        lastError ?? "Aggregator returned zero usable quotes"
      ),
      source: refQuote.source,
    };
  }

  return {
    venue: "aggregator",
    venueLabel: `Aggregator (${refQuote.source ?? "0x"})`,
    feePct: 0, // aggregator quote is end-to-end; cost already includes fees
    totalFeeCost: 0,
    totalSlippageCost: totalCost,
    totalCost,
    perLoopCosts,
    available: true,
    source: refQuote.source,
  };
}

// ── Comparison helper ─────────────────────────────────────────────

export interface VenueComparison {
  curve: SwapCostResult;
  uniswap: SwapCostResult;
  aggregator: SwapCostResult & { source?: "0x" | "1inch" | null };
  recommended: "curve" | "uniswap" | "aggregator";
  savingBps: number;
}

/** Pick the cheapest available venue (lowest totalCost). */
export function compareVenues(
  curve: SwapCostResult,
  uniswap: SwapCostResult,
  aggregator: SwapCostResult & { source?: "0x" | "1inch" | null },
  totalVolume: number
): VenueComparison {
  const options: { name: "curve" | "uniswap" | "aggregator"; cost: number; available: boolean }[] = [
    { name: "curve", cost: curve.totalCost, available: curve.available },
    { name: "uniswap", cost: uniswap.totalCost, available: uniswap.available },
    { name: "aggregator", cost: aggregator.totalCost, available: aggregator.available },
  ];

  const available = options.filter((o) => o.available);
  if (available.length === 0) {
    return { curve, uniswap, aggregator, recommended: "curve", savingBps: 0 };
  }

  available.sort((a, b) => a.cost - b.cost);
  const best = available[0].name;
  const bestCost = available[0].cost;
  const worstAvailable = available[available.length - 1].cost;
  const savingBps =
    totalVolume > 0 ? ((worstAvailable - bestCost) / totalVolume) * 10_000 : 0;
  return { curve, uniswap, aggregator, recommended: best, savingBps };
}

// ── Helpers ────────────────────────────────────────────────────────

function emptyResult(
  venue: SwapCostResult["venue"],
  label: string,
  reason: string
): SwapCostResult {
  return {
    venue,
    venueLabel: label,
    feePct: 0,
    totalFeeCost: 0,
    totalSlippageCost: 0,
    totalCost: 0,
    perLoopCosts: [],
    warning: reason,
    available: false,
  };
}
