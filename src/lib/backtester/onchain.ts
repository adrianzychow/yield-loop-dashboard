/**
 * On-chain data fetching for backtester.
 * Uses viem to query archive node for historical sUSDS exchange rates
 * and Chainlink price feeds (DAI/USD, USDT/USD) — matching the exact
 * data sources used by the MorphoChainlinkOracleV2 on-chain.
 */

import {
  createPublicClient,
  http,
  type PublicClient,
  parseAbi,
  formatUnits,
} from "viem";
import { mainnet } from "viem/chains";

// ── Contract ABIs (minimal) ─────────────────────────────────────────

const ERC4626_ABI = parseAbi([
  "function convertToAssets(uint256 shares) view returns (uint256)",
]);

const CHAINLINK_ABI = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);

// ── Known addresses ─────────────────────────────────────────────────
// Read directly from the MorphoChainlinkOracleV2 at 0x0C426d...

export const SUSDS_VAULT = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD" as const;

// BASE_FEED_1: DAI/USD Chainlink aggregator (oracle uses DAI/USD, not USDS/USD)
export const BASE_FEED = "0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9" as const;
// QUOTE_FEED_1: USDT/USD Chainlink aggregator
export const QUOTE_FEED = "0x3E7d1eAB13ad0104d2750B8863b489D65364e32D" as const;
// Both feeds: 8 decimals
const CHAINLINK_DECIMALS = 8;

// Morpho oracle for reference
export const MORPHO_ORACLE = "0x0C426d174FC88B7A25d59945Ab2F7274Bf7B4C79" as const;

// ── Client factory ──────────────────────────────────────────────────

let cachedClient: PublicClient | null = null;

export function getClient(rpcUrl: string): PublicClient {
  if (cachedClient) return cachedClient;
  cachedClient = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl, {
      batch: true,
      retryCount: 3,
      retryDelay: 1000,
    }),
  });
  return cachedClient;
}

// ── Block timestamp resolution ──────────────────────────────────────

/**
 * Find block numbers for a series of hourly timestamps.
 *
 * Strategy: binary search only for the start and end blocks,
 * then linearly interpolate all intermediate blocks.
 * Post-merge Ethereum has ~12s block times, making interpolation
 * very accurate (typically within 1-2 blocks).
 */
export async function resolveHourlyBlocks(
  client: PublicClient,
  startTimestamp: number,
  endTimestamp: number
): Promise<{ timestamp: number; blockNumber: number }[]> {
  const latestBlock = await client.getBlock({ blockTag: "latest" });
  const latestNumber = Number(latestBlock.number);
  const latestTs = Number(latestBlock.timestamp);

  const clampedEnd = Math.min(endTimestamp, latestTs);

  // Binary search only for start and end blocks
  const AVG_BLOCK_TIME = 12;
  const estStart = Math.max(
    1,
    latestNumber - Math.ceil((latestTs - startTimestamp) / AVG_BLOCK_TIME)
  );
  const estEnd = Math.max(
    1,
    latestNumber - Math.ceil((latestTs - clampedEnd) / AVG_BLOCK_TIME)
  );

  const [startBlock, endBlock] = await Promise.all([
    binarySearchBlock(
      client,
      startTimestamp,
      Math.max(1, estStart - 500),
      Math.min(latestNumber, estStart + 500)
    ),
    binarySearchBlock(
      client,
      clampedEnd,
      Math.max(1, estEnd - 500),
      Math.min(latestNumber, estEnd + 500)
    ),
  ]);

  // Generate hourly timestamps and interpolate block numbers
  const totalSeconds = clampedEnd - startTimestamp;
  const totalBlocks = endBlock - startBlock;
  const blocksPerSecond = totalSeconds > 0 ? totalBlocks / totalSeconds : 0;

  const results: { timestamp: number; blockNumber: number }[] = [];
  for (let ts = startTimestamp; ts <= clampedEnd; ts += 3600) {
    const elapsed = ts - startTimestamp;
    const blockNum = Math.round(startBlock + elapsed * blocksPerSecond);
    results.push({ timestamp: ts, blockNumber: Math.min(blockNum, latestNumber) });
  }

  return results;
}

/**
 * Binary search for the block closest to a target timestamp.
 */
async function binarySearchBlock(
  client: PublicClient,
  targetTs: number,
  low: number,
  high: number
): Promise<number> {
  // Limit iterations to prevent infinite loops
  let iterations = 0;
  const MAX_ITERATIONS = 20;

  while (low < high && iterations < MAX_ITERATIONS) {
    iterations++;
    const mid = Math.floor((low + high) / 2);
    try {
      const block = await client.getBlock({ blockNumber: BigInt(mid) });
      const blockTs = Number(block.timestamp);
      if (blockTs < targetTs) {
        low = mid + 1;
      } else {
        high = mid;
      }
    } catch {
      // If block doesn't exist, move forward
      low = mid + 1;
    }
  }
  return low;
}

// ── Exchange rate queries ───────────────────────────────────────────

/**
 * Fetch sUSDS → USDS exchange rate at a specific block.
 * Returns decimal (e.g., 1.05 means 1 sUSDS = 1.05 USDS).
 */
export async function getExchangeRateAtBlock(
  client: PublicClient,
  vaultAddress: string,
  blockNumber: number
): Promise<number> {
  const result = await client.readContract({
    address: vaultAddress as `0x${string}`,
    abi: ERC4626_ABI,
    functionName: "convertToAssets",
    args: [BigInt(10) ** BigInt(18)], // 1e18 shares
    blockNumber: BigInt(blockNumber),
  });
  return Number(formatUnits(result as bigint, 18));
}

/**
 * Batch fetch exchange rates at multiple blocks.
 * Processes in batches to respect RPC rate limits.
 */
export async function batchGetExchangeRates(
  client: PublicClient,
  vaultAddress: string,
  blocks: { timestamp: number; blockNumber: number }[]
): Promise<{ timestamp: number; blockNumber: number; rate: number }[]> {
  const results: { timestamp: number; blockNumber: number; rate: number }[] = [];
  const BATCH_SIZE = 15; // Conservative batch size for archive calls

  for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
    const batch = blocks.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async ({ timestamp, blockNumber }) => {
        try {
          const rate = await getExchangeRateAtBlock(
            client,
            vaultAddress,
            blockNumber
          );
          return { timestamp, blockNumber, rate };
        } catch (err) {
          console.warn(
            `Failed to get exchange rate at block ${blockNumber}:`,
            err
          );
          return { timestamp, blockNumber, rate: -1 }; // sentinel for interpolation
        }
      })
    );
    results.push(...batchResults);

    // Small delay between batches to avoid rate limiting
    if (i + BATCH_SIZE < blocks.length) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  // Interpolate any failed points
  return interpolateFailedPoints(results);
}

// ── Chainlink price feed queries ────────────────────────────────────

/**
 * Fetch a Chainlink price feed answer at a specific block.
 * Returns price as a float (e.g., 0.9997 for DAI/USD).
 */
export async function getChainlinkPriceAtBlock(
  client: PublicClient,
  feedAddress: string,
  blockNumber: number
): Promise<number> {
  const result = await client.readContract({
    address: feedAddress as `0x${string}`,
    abi: CHAINLINK_ABI,
    functionName: "latestRoundData",
    blockNumber: BigInt(blockNumber),
  });
  // result is [roundId, answer, startedAt, updatedAt, answeredInRound]
  const answer = (result as readonly [bigint, bigint, bigint, bigint, bigint])[1];
  return Number(answer) / 10 ** CHAINLINK_DECIMALS;
}

/**
 * Batch fetch Chainlink prices at multiple blocks for a given feed.
 */
export async function batchGetChainlinkPrices(
  client: PublicClient,
  feedAddress: string,
  blocks: { timestamp: number; blockNumber: number }[]
): Promise<{ timestamp: number; blockNumber: number; price: number }[]> {
  const results: { timestamp: number; blockNumber: number; price: number }[] = [];
  const BATCH_SIZE = 15;

  for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
    const batch = blocks.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async ({ timestamp, blockNumber }) => {
        try {
          const price = await getChainlinkPriceAtBlock(
            client,
            feedAddress,
            blockNumber
          );
          return { timestamp, blockNumber, price };
        } catch (err) {
          console.warn(
            `Failed to get Chainlink price at block ${blockNumber}:`,
            err
          );
          return { timestamp, blockNumber, price: -1 };
        }
      })
    );
    results.push(...batchResults);

    if (i + BATCH_SIZE < blocks.length) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  // Forward-fill failed points
  return interpolateFailedPricePoints(results);
}

/**
 * Forward-fill any points that failed to fetch (price === -1).
 */
function interpolateFailedPricePoints(
  points: { timestamp: number; blockNumber: number; price: number }[]
): { timestamp: number; blockNumber: number; price: number }[] {
  let lastGood = -1;
  for (const point of points) {
    if (point.price > 0) lastGood = point.price;
    else if (lastGood > 0) point.price = lastGood;
  }
  lastGood = -1;
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].price > 0) lastGood = points[i].price;
    else if (lastGood > 0) points[i].price = lastGood;
  }
  return points.filter((p) => p.price > 0);
}

/**
 * Forward-fill any points that failed to fetch (rate === -1).
 */
function interpolateFailedPoints(
  points: { timestamp: number; blockNumber: number; rate: number }[]
): { timestamp: number; blockNumber: number; rate: number }[] {
  let lastGoodRate = -1;

  // Forward pass: fill with last known good value
  for (const point of points) {
    if (point.rate > 0) {
      lastGoodRate = point.rate;
    } else if (lastGoodRate > 0) {
      point.rate = lastGoodRate;
    }
  }

  // Backward pass: fill any leading gaps
  lastGoodRate = -1;
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].rate > 0) {
      lastGoodRate = points[i].rate;
    } else if (lastGoodRate > 0) {
      points[i].rate = lastGoodRate;
    }
  }

  return points.filter((p) => p.rate > 0);
}
