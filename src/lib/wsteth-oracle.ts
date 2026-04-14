/**
 * wstETH CAPO Oracle computation.
 *
 * Aave's wstETH oracle uses a Correlated Asset Price Oracle (CAPO) that caps
 * the wstETH/stETH exchange rate's growth to prevent oracle manipulation.
 *
 * Oracle price = min(lidoRatio, capoCeiling) * ETH/USD
 *
 * Where:
 *   lidoRatio    = stETH.getPooledEthByShares(1e18) / 1e18  (wstETH → ETH)
 *   capoCeiling  = snapshotRatio + maxGrowthPerSecond * (now - snapshotTimestamp)
 *   ETH/USD      = Chainlink ETH/USD feed (8 decimals)
 */

import { type PublicClient, parseAbi, formatUnits } from "viem";

// ── Contract addresses ─────────────────────────────────────────────

export const STETH_ADDRESS = "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84" as const;
export const ETH_USD_FEED = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419" as const;
export const CAPO_ADAPTER = "0xe1D97bF61901B075E9626c8A2340a7De385861Ef" as const;

// ── ABIs ───────────────────────────────────────────────────────────

const STETH_ABI = parseAbi([
  "function getPooledEthByShares(uint256 _sharesAmount) view returns (uint256)",
]);

const CHAINLINK_ABI = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

const CAPO_ABI = parseAbi([
  "function getSnapshotRatio() view returns (uint256)",
  "function getSnapshotTimestamp() view returns (uint256)",
  "function getMaxRatioGrowthPerSecond() view returns (uint256)",
]);

// ── Types ──────────────────────────────────────────────────────────

export interface CapoParams {
  snapshotRatio: bigint;
  snapshotTimestamp: bigint;
  maxGrowthPerSecond: bigint;
}

export interface WstEthOracleResult {
  lidoRatio: number;        // raw wstETH/ETH ratio from Lido
  ethUsd: number;           // ETH/USD from Chainlink
  effectiveRatio: number;   // min(lidoRatio, capoCeiling)
  oraclePrice: number;      // effectiveRatio * ethUsd
  isCapped: boolean;        // whether CAPO ceiling was applied
  capoCeiling: number;      // the ceiling value
}

// ── CAPO parameter fetching ────────────────────────────────────────

export async function fetchCapoParams(
  client: PublicClient,
  blockNumber?: bigint
): Promise<CapoParams> {
  const opts = blockNumber ? { blockNumber } : {};

  const [snapshotRatio, snapshotTimestamp, maxGrowthPerSecond] =
    await Promise.all([
      client.readContract({
        address: CAPO_ADAPTER,
        abi: CAPO_ABI,
        functionName: "getSnapshotRatio",
        ...opts,
      }) as Promise<bigint>,
      client.readContract({
        address: CAPO_ADAPTER,
        abi: CAPO_ABI,
        functionName: "getSnapshotTimestamp",
        ...opts,
      }) as Promise<bigint>,
      client.readContract({
        address: CAPO_ADAPTER,
        abi: CAPO_ABI,
        functionName: "getMaxRatioGrowthPerSecond",
        ...opts,
      }) as Promise<bigint>,
    ]);

  return { snapshotRatio, snapshotTimestamp, maxGrowthPerSecond };
}

// ── CAPO ceiling computation ───────────────────────────────────────

export function computeCapoCeiling(
  capo: CapoParams,
  atTimestamp: number
): bigint {
  const tsSec = BigInt(Math.floor(atTimestamp));
  const elapsed =
    tsSec > capo.snapshotTimestamp
      ? tsSec - capo.snapshotTimestamp
      : BigInt(0);
  return capo.snapshotRatio + capo.maxGrowthPerSecond * elapsed;
}

// ── Live oracle price ──────────────────────────────────────────────

export async function fetchLiveWstEthOracle(
  client: PublicClient
): Promise<WstEthOracleResult> {
  const [ratioRaw, feedRaw, capo] = await Promise.all([
    client.readContract({
      address: STETH_ADDRESS,
      abi: STETH_ABI,
      functionName: "getPooledEthByShares",
      args: [BigInt(10) ** BigInt(18)],
    }) as Promise<bigint>,
    client.readContract({
      address: ETH_USD_FEED,
      abi: CHAINLINK_ABI,
      functionName: "latestRoundData",
    }) as Promise<readonly [bigint, bigint, bigint, bigint, bigint]>,
    fetchCapoParams(client),
  ]);

  const lidoRatio = Number(formatUnits(ratioRaw, 18));
  const ethUsd = Number(feedRaw[1]) / 1e8;

  const nowSec = Math.floor(Date.now() / 1000);
  const ceiling = computeCapoCeiling(capo, nowSec);
  const isCapped = ratioRaw > ceiling;
  const effectiveRatioBigInt = isCapped ? ceiling : ratioRaw;
  const effectiveRatio = Number(formatUnits(effectiveRatioBigInt, 18));
  const capoCeiling = Number(formatUnits(ceiling, 18));

  return {
    lidoRatio,
    ethUsd,
    effectiveRatio,
    oraclePrice: effectiveRatio * ethUsd,
    isCapped,
    capoCeiling,
  };
}

// ── Historical oracle snapshot at a specific block ─────────────────

export async function fetchWstEthOracleAtBlock(
  client: PublicClient,
  blockNumber: bigint,
  timestamp: number,
  capo: CapoParams
): Promise<{
  lidoRatio: number;
  ethUsd: number;
  effectiveRatio: number;
  oraclePrice: number;
  isCapped: boolean;
} | null> {
  try {
    const [ratioRaw, feedRaw] = await Promise.all([
      client.readContract({
        address: STETH_ADDRESS,
        abi: STETH_ABI,
        functionName: "getPooledEthByShares",
        args: [BigInt(10) ** BigInt(18)],
        blockNumber,
      }) as Promise<bigint>,
      client.readContract({
        address: ETH_USD_FEED,
        abi: CHAINLINK_ABI,
        functionName: "latestRoundData",
        blockNumber,
      }) as Promise<readonly [bigint, bigint, bigint, bigint, bigint]>,
    ]);

    const lidoRatio = Number(formatUnits(ratioRaw, 18));
    const ethUsd = Number(feedRaw[1]) / 1e8;

    const ceiling = computeCapoCeiling(capo, timestamp);
    const isCapped = ratioRaw > ceiling;
    const effectiveRatioBigInt = isCapped ? ceiling : ratioRaw;
    const effectiveRatio = Number(formatUnits(effectiveRatioBigInt, 18));

    return {
      lidoRatio,
      ethUsd,
      effectiveRatio,
      oraclePrice: effectiveRatio * ethUsd,
      isCapped,
    };
  } catch (err) {
    console.warn(
      `Failed wstETH oracle at block ${blockNumber}:`,
      (err as Error).message?.slice(0, 80)
    );
    return null;
  }
}
