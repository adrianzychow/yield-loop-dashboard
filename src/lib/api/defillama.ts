import { DefiLlamaPool, DefiLlamaBorrowPool, BorrowMarket, DefiLlamaChartPoint } from "../types";
import { AAVE_TOKEN_ADDRESSES } from "../constants";
import { getAaveLink, getHorizonLink } from "../utils";

const POOLS_URL = "https://yields.llama.fi/pools";
const BORROW_URL = "https://yields.llama.fi/lendBorrow";

interface PoolsResponse {
  status: string;
  data: DefiLlamaPool[];
}

let poolsCache: { data: DefiLlamaPool[]; ts: number } | null = null;
let borrowCache: { data: DefiLlamaBorrowPool[]; ts: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000;

export async function fetchPools(): Promise<DefiLlamaPool[]> {
  if (poolsCache && Date.now() - poolsCache.ts < CACHE_TTL) {
    return poolsCache.data;
  }
  const res = await fetch(POOLS_URL);
  const json: PoolsResponse = await res.json();
  const data = json.data.filter((p) => p.chain === "Ethereum");
  poolsCache = { data, ts: Date.now() };
  return data;
}

export async function fetchBorrowPools(): Promise<DefiLlamaBorrowPool[]> {
  if (borrowCache && Date.now() - borrowCache.ts < CACHE_TTL) {
    return borrowCache.data;
  }
  const res = await fetch(BORROW_URL);
  const json = await res.json();
  // lendBorrow endpoint returns an array directly (not wrapped in {data:...})
  const raw: DefiLlamaBorrowPool[] = Array.isArray(json) ? json : (json.data ?? []);
  borrowCache = { data: raw, ts: Date.now() };
  return raw;
}

/**
 * Find the base yield for an asset using direct pool IDs (most reliable)
 */
export function findBaseYieldByPoolId(
  pools: DefiLlamaPool[],
  poolIds: string[]
): number | null {
  for (const id of poolIds) {
    const match = pools.find((p) => p.pool === id);
    if (match && match.apy !== null && match.apy !== undefined) return match.apy;
  }
  return null;
}

/**
 * Fallback: find base yield by project and symbol
 */
export function findBaseYieldByProject(
  pools: DefiLlamaPool[],
  project: string,
  symbolHint: string
): number | null {
  const match = pools.find(
    (p) =>
      p.project === project &&
      p.symbol.toUpperCase().includes(symbolHint.toUpperCase())
  );
  if (match && match.apy !== null && match.apy !== undefined) return match.apy;
  return null;
}

/**
 * Fetch historical chart data for a pool
 */
export async function fetchPoolChart(
  poolId: string
): Promise<DefiLlamaChartPoint[]> {
  const res = await fetch(`https://yields.llama.fi/chart/${poolId}`);
  const json = await res.json();
  return json?.data ?? [];
}

/**
 * Get Aave borrow markets from DeFiLlama lendBorrow data
 */
export function getAaveBorrowMarkets(
  borrowPools: DefiLlamaBorrowPool[],
  assetName: string,
  poolIds: Record<string, string>,
  venue: string
): BorrowMarket[] {
  const markets: BorrowMarket[] = [];

  for (const [borrowAsset, poolId] of Object.entries(poolIds)) {
    const pool = borrowPools.find((p) => p.pool === poolId);
    if (!pool) continue;

    const borrowRate = pool.apyBaseBorrow ?? 0;
    const rewardRate = pool.apyRewardBorrow ?? 0;
    const effectiveRate = Math.max(0, borrowRate - rewardRate);
    const liquidity =
      (pool.totalSupplyUsd ?? 0) - (pool.totalBorrowUsd ?? 0);

    const link =
      venue === "Aave Horizon"
        ? getHorizonLink()
        : getAaveLink(borrowAsset, AAVE_TOKEN_ADDRESSES[borrowAsset] ?? "");

    const totalSupply = pool.totalSupplyUsd ?? 0;
    const totalBorrow = pool.totalBorrowUsd ?? 0;
    const utilization = totalSupply > 0 ? totalBorrow / totalSupply : null;

    markets.push({
      venue,
      pair: `${assetName}/${borrowAsset}`,
      borrowAsset,
      borrowRate: effectiveRate,
      liquidity: Math.max(0, liquidity),
      utilization,
      link,
    });
  }

  return markets;
}
