/**
 * On-chain data fetching for backtester.
 * Uses viem multicall to efficiently query archive node for
 * historical sUSDS exchange rates and Chainlink price feeds —
 * matching the exact data sources used by the MorphoChainlinkOracleV2.
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
]);

// ── Known addresses (read from MorphoChainlinkOracleV2) ─────────────

export const SUSDS_VAULT = "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD" as const;
export const BASE_FEED = "0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9" as const; // DAI/USD
export const QUOTE_FEED = "0x3E7d1eAB13ad0104d2750B8863b489D65364e32D" as const; // USDT/USD
const CHAINLINK_DECIMALS = 8;

export const MORPHO_ORACLE = "0x0C426d174FC88B7A25d59945Ab2F7274Bf7B4C79" as const;

// ── Client factory ──────────────────────────────────────────────────

let cachedClient: PublicClient | null = null;

export function getClient(rpcUrl: string): PublicClient {
  if (cachedClient) return cachedClient;
  cachedClient = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl, {
      retryCount: 3,
      retryDelay: 500,
      timeout: 30_000,
    }),
  });
  return cachedClient;
}

// ── Block timestamp resolution ──────────────────────────────────────

/**
 * Resolve blocks at a given interval (in seconds).
 * Defaults to 3600 (hourly). Use 7200 for 2h, 14400 for 4h, etc.
 */
export async function resolveHourlyBlocks(
  client: PublicClient,
  startTimestamp: number,
  endTimestamp: number,
  intervalSeconds: number = 3600
): Promise<{ timestamp: number; blockNumber: number }[]> {
  const latestBlock = await client.getBlock({ blockTag: "latest" });
  const latestNumber = Number(latestBlock.number);
  const latestTs = Number(latestBlock.timestamp);
  const clampedEnd = Math.min(endTimestamp, latestTs);

  const AVG_BLOCK_TIME = 12;
  const estStart = Math.max(1, latestNumber - Math.ceil((latestTs - startTimestamp) / AVG_BLOCK_TIME));
  const estEnd = Math.max(1, latestNumber - Math.ceil((latestTs - clampedEnd) / AVG_BLOCK_TIME));

  const [startBlock, endBlock] = await Promise.all([
    binarySearchBlock(client, startTimestamp, Math.max(1, estStart - 500), Math.min(latestNumber, estStart + 500)),
    binarySearchBlock(client, clampedEnd, Math.max(1, estEnd - 500), Math.min(latestNumber, estEnd + 500)),
  ]);

  const totalSeconds = clampedEnd - startTimestamp;
  const totalBlocks = endBlock - startBlock;
  const blocksPerSecond = totalSeconds > 0 ? totalBlocks / totalSeconds : 0;

  const results: { timestamp: number; blockNumber: number }[] = [];
  for (let ts = startTimestamp; ts <= clampedEnd; ts += intervalSeconds) {
    const blockNum = Math.round(startBlock + (ts - startTimestamp) * blocksPerSecond);
    results.push({ timestamp: ts, blockNumber: Math.min(blockNum, latestNumber) });
  }
  return results;
}

async function binarySearchBlock(client: PublicClient, targetTs: number, low: number, high: number): Promise<number> {
  for (let i = 0; i < 20 && low < high; i++) {
    const mid = Math.floor((low + high) / 2);
    try {
      const block = await client.getBlock({ blockNumber: BigInt(mid) });
      if (Number(block.timestamp) < targetTs) low = mid + 1;
      else high = mid;
    } catch { low = mid + 1; }
  }
  return low;
}

// ── Combined oracle data fetch (all 3 calls per block) ─────────────

export interface OracleSnapshot {
  timestamp: number;
  blockNumber: number;
  exchangeRate: number;
  basePrice: number;  // DAI/USD
  quotePrice: number; // USDT/USD
}

/**
 * Fetch exchange rate + DAI/USD + USDT/USD at each block.
 * Uses parallel batches with all 3 calls per block firing concurrently.
 * Much faster than sequential fetching.
 */
export async function batchGetOracleSnapshots(
  client: PublicClient,
  vaultAddress: string,
  blocks: { timestamp: number; blockNumber: number }[]
): Promise<OracleSnapshot[]> {
  const results: OracleSnapshot[] = [];
  // Higher concurrency — fire 30 blocks at once (90 RPC calls)
  const BATCH_SIZE = 30;

  for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
    const batch = blocks.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async ({ timestamp, blockNumber }) => {
        try {
          const bn = BigInt(blockNumber);
          const [rateRaw, baseFeedRaw, quoteFeedRaw] = await Promise.all([
            client.readContract({
              address: vaultAddress as `0x${string}`,
              abi: ERC4626_ABI,
              functionName: "convertToAssets",
              args: [BigInt(10) ** BigInt(18)],
              blockNumber: bn,
            }),
            client.readContract({
              address: BASE_FEED,
              abi: CHAINLINK_ABI,
              functionName: "latestRoundData",
              blockNumber: bn,
            }),
            client.readContract({
              address: QUOTE_FEED,
              abi: CHAINLINK_ABI,
              functionName: "latestRoundData",
              blockNumber: bn,
            }),
          ]);

          const exchangeRate = Number(formatUnits(rateRaw as bigint, 18));
          const baseAnswer = (baseFeedRaw as readonly [bigint, bigint, bigint, bigint, bigint])[1];
          const quoteAnswer = (quoteFeedRaw as readonly [bigint, bigint, bigint, bigint, bigint])[1];
          const basePrice = Number(baseAnswer) / 10 ** CHAINLINK_DECIMALS;
          const quotePrice = Number(quoteAnswer) / 10 ** CHAINLINK_DECIMALS;

          return { timestamp, blockNumber, exchangeRate, basePrice, quotePrice };
        } catch (err) {
          console.warn(`Failed oracle snapshot at block ${blockNumber}:`, (err as Error).message?.slice(0, 80));
          return null;
        }
      })
    );

    for (const r of batchResults) {
      if (r) results.push(r);
    }

    // Brief delay between batches
    if (i + BATCH_SIZE < blocks.length) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  // Forward-fill gaps
  return forwardFillSnapshots(results, blocks);
}

function forwardFillSnapshots(
  results: OracleSnapshot[],
  allBlocks: { timestamp: number; blockNumber: number }[]
): OracleSnapshot[] {
  if (results.length === 0) return [];

  const byTs = new Map<number, OracleSnapshot>();
  for (const r of results) byTs.set(r.timestamp, r);

  const filled: OracleSnapshot[] = [];
  let last = results[0];

  for (const block of allBlocks) {
    if (byTs.has(block.timestamp)) {
      last = byTs.get(block.timestamp)!;
    }
    filled.push({
      timestamp: block.timestamp,
      blockNumber: block.blockNumber,
      exchangeRate: last.exchangeRate,
      basePrice: last.basePrice,
      quotePrice: last.quotePrice,
    });
  }

  return filled;
}
