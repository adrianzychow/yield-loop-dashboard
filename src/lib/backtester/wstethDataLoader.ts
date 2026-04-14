/**
 * Data loader for wstETH/ETH backtester — CLIENT-SIDE version.
 *
 * Data sources:
 * - wstETH/stETH ratio: Lido stETH.getPooledEthByShares (on-chain)
 * - ETH/USD price: Chainlink ETH/USD feed (on-chain)
 * - CAPO ceiling: WstETHPriceCapAdapter (on-chain, fetched once)
 * - wstETH/USD off-chain price: CoinGecko (for oracle deviation analysis)
 * - Borrow APY: Morpho GraphQL API (interval: HOUR) for wstETH/WETH market
 * - Oracle price: min(lidoRatio, capoCeiling) * ETH/USD
 */

import type { HourlyDataPoint, RawHistoricalData } from "./types";
import { getClient, resolveHourlyBlocks } from "./onchain";
import { alignToHourlySeries } from "./dataLoader";
import type { LoadProgress } from "./dataLoader";
import {
  fetchCapoParams,
  fetchWstEthOracleAtBlock,
  type CapoParams,
} from "../wsteth-oracle";
import type { PublicClient } from "viem";

const MORPHO_API = "https://blue-api.morpho.org/graphql";
const AAVE_V3_WETH_POOL_ID = "e880e828-ca59-4ec6-8d4f-27182a4dc23d";

// ── Adaptive interval based on date range ───────────────────────────

function getIntervalSeconds(daysBack: number): number {
  if (daysBack <= 14) return 3600;
  if (daysBack <= 45) return 3600 * 2;
  if (daysBack <= 90) return 3600 * 4;
  return 3600 * 6;
}

// ── CoinGecko wstETH price (off-chain comparison) ──────────────────

async function fetchCoinGeckoHourly(
  cgId: string,
  startTimestamp: number,
  endTimestamp: number
): Promise<{ timestamp: number; price: number }[]> {
  const CHUNK_DAYS = 89;
  const CHUNK_SECONDS = CHUNK_DAYS * 86400;
  const allPrices: { timestamp: number; price: number }[] = [];

  let from = startTimestamp;
  while (from < endTimestamp) {
    const to = Math.min(from + CHUNK_SECONDS, endTimestamp);
    const cgUrl = `https://api.coingecko.com/api/v3/coins/${cgId}/market_chart/range?vs_currency=usd&from=${from}&to=${to}`;
    const proxyUrl = `/api/backtest?cgUrl=${encodeURIComponent(cgUrl)}`;

    try {
      const res = await fetch(proxyUrl);
      if (!res.ok) {
        console.warn(`CoinGecko ${cgId} chunk failed: ${res.status}`);
        from = to;
        continue;
      }
      const json = await res.json();
      const prices = (json.prices ?? []).map(
        ([ts, price]: [number, number]) => ({
          timestamp: Math.floor(ts / 1000),
          price,
        })
      );
      allPrices.push(...prices);
    } catch (err) {
      console.warn(`CoinGecko ${cgId} fetch error:`, err);
    }

    from = to;
    if (from < endTimestamp) {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  const byHour = new Map<number, { timestamp: number; price: number }>();
  for (const p of allPrices) {
    const hourKey = Math.floor(p.timestamp / 3600) * 3600;
    byHour.set(hourKey, { timestamp: hourKey, price: p.price });
  }

  return Array.from(byHour.values()).sort((a, b) => a.timestamp - b.timestamp);
}

// ── DeFiLlama Aave borrow rates ────────────────────────────────────

async function fetchAaveBorrowRatesFromLlama(
  startTimestamp: number,
  endTimestamp: number
): Promise<{ timestamp: number; rate: number }[]> {
  try {
    const res = await fetch(
      `https://yields.llama.fi/chart/${AAVE_V3_WETH_POOL_ID}`
    );
    const json = await res.json();
    const points = json?.data ?? [];

    return points
      .map((p: { timestamp: string; apyBase: number | null }) => {
        const ts = Math.floor(new Date(p.timestamp).getTime() / 1000);
        // DeFiLlama apyBase is supply APY; for borrow, we approximate
        // using the relation: borrowRate ≈ supplyRate / utilization
        // But DeFiLlama chart only has supply side. Use apyBase as borrow proxy.
        // Note: The lendBorrow endpoint has the real borrow rate but no history.
        // For accuracy we use the supply rate as a lower bound of the borrow rate.
        const rate = (p.apyBase ?? 0) / 100; // convert percent to decimal
        return { timestamp: ts, rate };
      })
      .filter(
        (p: { timestamp: number }) =>
          p.timestamp >= startTimestamp && p.timestamp <= endTimestamp
      )
      .sort(
        (a: { timestamp: number }, b: { timestamp: number }) =>
          a.timestamp - b.timestamp
      );
  } catch (err) {
    console.error("DeFiLlama Aave borrow rates error:", err);
    return [];
  }
}

// ── Morpho hourly borrow rates ─────────────────────────────────────

const MORPHO_HOURLY_QUERY = `
  query GetMarketHistoryHourly($uniqueKey: String!, $startTs: Int!, $endTs: Int!) {
    marketByUniqueKey(uniqueKey: $uniqueKey, chainId: 1) {
      historicalState {
        borrowApy(options: {
          startTimestamp: $startTs
          endTimestamp: $endTs
          interval: HOUR
        }) {
          x
          y
        }
      }
    }
  }
`;

async function fetchMorphoHourlyBorrowRates(
  marketUniqueKey: string,
  startTimestamp: number,
  endTimestamp: number
): Promise<{ timestamp: number; rate: number }[]> {
  try {
    const res = await fetch(MORPHO_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: MORPHO_HOURLY_QUERY,
        variables: {
          uniqueKey: marketUniqueKey,
          startTs: startTimestamp,
          endTs: endTimestamp,
        },
      }),
    });

    const json = await res.json();
    const points =
      json?.data?.marketByUniqueKey?.historicalState?.borrowApy ?? [];

    return points
      .map((p: { x: number; y: number }) => ({
        timestamp: p.x,
        rate: p.y,
      }))
      .sort(
        (a: { timestamp: number }, b: { timestamp: number }) =>
          a.timestamp - b.timestamp
      );
  } catch (err) {
    console.error("Morpho hourly borrow rates error:", err);
    return [];
  }
}

// ── Batch oracle snapshots for wstETH ──────────────────────────────

interface WstEthSnapshot {
  timestamp: number;
  blockNumber: number;
  exchangeRate: number; // effective wstETH/ETH ratio (CAPO-adjusted)
  ethUsd: number;       // ETH/USD from Chainlink
}

async function batchGetWstEthSnapshots(
  client: PublicClient,
  blocks: { timestamp: number; blockNumber: number }[],
  capo: CapoParams
): Promise<WstEthSnapshot[]> {
  const results: WstEthSnapshot[] = [];
  const BATCH_SIZE = 30;

  for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
    const batch = blocks.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async ({ timestamp, blockNumber }) => {
        const oracle = await fetchWstEthOracleAtBlock(
          client,
          BigInt(blockNumber),
          timestamp,
          capo
        );
        if (!oracle) return null;
        return {
          timestamp,
          blockNumber,
          exchangeRate: oracle.effectiveRatio,
          ethUsd: oracle.ethUsd,
        };
      })
    );

    for (const r of batchResults) {
      if (r) results.push(r);
    }

    if (i + BATCH_SIZE < blocks.length) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  // Forward-fill gaps
  return forwardFillSnapshots(results, blocks);
}

function forwardFillSnapshots(
  results: WstEthSnapshot[],
  allBlocks: { timestamp: number; blockNumber: number }[]
): WstEthSnapshot[] {
  if (results.length === 0) return [];

  const byTs = new Map<number, WstEthSnapshot>();
  for (const r of results) byTs.set(r.timestamp, r);

  const filled: WstEthSnapshot[] = [];
  let last = results[0];

  for (const block of allBlocks) {
    if (byTs.has(block.timestamp)) {
      last = byTs.get(block.timestamp)!;
    }
    filled.push({
      timestamp: block.timestamp,
      blockNumber: block.blockNumber,
      exchangeRate: last.exchangeRate,
      ethUsd: last.ethUsd,
    });
  }

  return filled;
}

// ── Client-side loader for wstETH ──────────────────────────────────

export async function loadWstEthBacktestDataClient(
  rpcUrl: string,
  marketUniqueKey: string,
  startTimestamp: number,
  endTimestamp: number,
  onProgress?: (progress: LoadProgress) => void
): Promise<HourlyDataPoint[]> {
  const daysBack = Math.ceil((endTimestamp - startTimestamp) / 86400);
  const intervalSeconds = getIntervalSeconds(daysBack);
  const intervalLabel =
    intervalSeconds === 3600 ? "hourly" : `${intervalSeconds / 3600}h`;

  onProgress?.({
    stage: "blocks",
    message: `Resolving ${intervalLabel} blocks for ${daysBack} days...`,
    percent: 5,
  });

  const client = getClient(rpcUrl);
  const blocks = await resolveHourlyBlocks(
    client,
    startTimestamp,
    endTimestamp,
    intervalSeconds
  );

  console.log(
    `[wstETH Backtest] Resolved ${blocks.length} blocks (${intervalLabel} intervals for ${daysBack}d)`
  );

  onProgress?.({
    stage: "onchain",
    message: "Fetching CAPO parameters...",
    percent: 10,
  });

  // Fetch CAPO parameters once (current snapshot)
  const capo = await fetchCapoParams(client);

  onProgress?.({
    stage: "onchain",
    message: `Fetching on-chain data for ${blocks.length} blocks...`,
    percent: 15,
  });

  // Fetch all data sources in parallel
  const [oracleSnapshots, coingeckoPrices, borrowRates] = await Promise.all([
    // On-chain: wstETH/ETH ratio + ETH/USD per block
    (async () => {
      const snapshots = await batchGetWstEthSnapshots(client, blocks, capo);
      onProgress?.({
        stage: "onchain",
        message: `On-chain data: ${snapshots.length}/${blocks.length} blocks fetched`,
        percent: 60,
      });
      return snapshots;
    })(),
    // CoinGecko: wstETH/USD for deviation analysis
    (async () => {
      onProgress?.({
        stage: "coingecko",
        message: "Fetching CoinGecko wstETH prices...",
        percent: 20,
      });
      return fetchCoinGeckoHourly("wrapped-steth", startTimestamp, endTimestamp);
    })(),
    // Borrow rates: Morpho or Aave depending on market key
    (async () => {
      const isAave = marketUniqueKey === "aave-wsteth-eth";
      onProgress?.({
        stage: "morpho",
        message: isAave
          ? "Fetching Aave borrow rates from DeFiLlama..."
          : "Fetching Morpho borrow rates...",
        percent: 25,
      });
      return isAave
        ? fetchAaveBorrowRatesFromLlama(startTimestamp, endTimestamp)
        : fetchMorphoHourlyBorrowRates(
            marketUniqueKey,
            startTimestamp,
            endTimestamp
          );
    })(),
  ]);

  console.log(
    `[wstETH Backtest] Raw data: ${oracleSnapshots.length} oracle, ${coingeckoPrices.length} CoinGecko, ${borrowRates.length} borrow rates`
  );

  onProgress?.({
    stage: "aligning",
    message: "Aligning data to time series...",
    percent: 85,
  });

  // Convert to RawHistoricalData format compatible with alignToHourlySeries
  // For wstETH: oraclePrice = exchangeRate * ethUsd / 1.0
  // So: exchangeRate = effective wstETH/ETH ratio, basePrice = ETH/USD, quotePrice = 1.0
  const raw: RawHistoricalData = {
    exchangeRates: oracleSnapshots.map((s) => ({
      timestamp: s.timestamp,
      blockNumber: s.blockNumber,
      rate: s.exchangeRate,
    })),
    basePrices: oracleSnapshots.map((s) => ({
      timestamp: s.timestamp,
      price: s.ethUsd,
    })),
    // quotePrice = 1.0 because debt is ETH-denominated
    // but we still want oraclePrice in USD for the engine
    quotePrices: oracleSnapshots.map((s) => ({
      timestamp: s.timestamp,
      price: 1.0,
    })),
    coingeckoPrices,
    borrowRates,
  };

  const aligned = alignToHourlySeries(
    raw,
    startTimestamp,
    endTimestamp,
    intervalSeconds
  );

  console.log(`[wstETH Backtest] Aligned ${aligned.length} data points`);

  onProgress?.({
    stage: "done",
    message: `Loaded ${aligned.length} data points`,
    percent: 100,
  });

  return aligned;
}
