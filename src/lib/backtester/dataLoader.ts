/**
 * Data loader for backtester — CLIENT-SIDE version.
 * Fetches all data directly from the browser to avoid Vercel serverless timeouts.
 *
 * Data sources:
 * - sUSDS exchange rate: Archive node RPC via viem (convertToAssets at blocks)
 * - DAI/USD price: Chainlink aggregator on-chain (BASE_FEED_1 from oracle)
 * - USDT/USD price: Chainlink aggregator on-chain (QUOTE_FEED_1 from oracle)
 * - sUSDS/USD off-chain price: CoinGecko (for oracle deviation analysis only)
 * - Borrow APY: Morpho GraphQL API (interval: HOUR)
 * - Oracle price: Computed from on-chain components per MorphoChainlinkOracleV2
 */

import type { HourlyDataPoint, RawHistoricalData } from "./types";
import {
  getClient,
  resolveHourlyBlocks,
  batchGetOracleSnapshots,
  type OracleSnapshot,
} from "./onchain";

const MORPHO_API = "https://blue-api.morpho.org/graphql";

// ── Progress callback type ──────────────────────────────────────────

export type LoadProgress = {
  stage: "blocks" | "onchain" | "coingecko" | "morpho" | "aligning" | "done";
  message: string;
  percent: number;
};

// ── Adaptive interval based on date range ───────────────────────────

function getIntervalSeconds(daysBack: number): number {
  if (daysBack <= 14) return 3600;      // hourly for ≤14 days
  if (daysBack <= 45) return 3600 * 2;  // 2-hourly for ≤45 days
  if (daysBack <= 90) return 3600 * 4;  // 4-hourly for ≤90 days
  return 3600 * 6;                       // 6-hourly for >90 days
}

// ── CoinGecko (off-chain comparison only) ───────────────────────────

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
    const url = `https://api.coingecko.com/api/v3/coins/${cgId}/market_chart/range?vs_currency=usd&from=${from}&to=${to}`;

    try {
      const res = await fetch(url);
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

// ── Morpho hourly borrow rates ──────────────────────────────────────

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

// ── Data alignment ──────────────────────────────────────────────────

export function alignToHourlySeries(
  raw: RawHistoricalData,
  startTimestamp: number,
  endTimestamp: number,
  intervalSeconds: number = 3600
): HourlyDataPoint[] {
  const exchangeMap = new Map<number, { rate: number; block: number }>();
  for (const p of raw.exchangeRates) {
    const hourKey = Math.floor(p.timestamp / 3600) * 3600;
    exchangeMap.set(hourKey, { rate: p.rate, block: p.blockNumber });
  }

  const baseMap = new Map<number, number>();
  for (const p of raw.basePrices) {
    const hourKey = Math.floor(p.timestamp / 3600) * 3600;
    baseMap.set(hourKey, p.price);
  }

  const quoteMap = new Map<number, number>();
  for (const p of raw.quotePrices) {
    const hourKey = Math.floor(p.timestamp / 3600) * 3600;
    quoteMap.set(hourKey, p.price);
  }

  const cgMap = new Map<number, number>();
  for (const p of raw.coingeckoPrices) {
    const hourKey = Math.floor(p.timestamp / 3600) * 3600;
    cgMap.set(hourKey, p.price);
  }

  const borrowMap = new Map<number, number>();
  for (const p of raw.borrowRates) {
    const hourKey = Math.floor(p.timestamp / 3600) * 3600;
    borrowMap.set(hourKey, p.rate);
  }

  const allTimestamps = new Set<number>();
  for (const k of exchangeMap.keys()) allTimestamps.add(k);
  for (const k of baseMap.keys()) allTimestamps.add(k);
  for (const k of quoteMap.keys()) allTimestamps.add(k);
  for (const k of borrowMap.keys()) allTimestamps.add(k);

  const minDataTs = Math.max(startTimestamp, Math.min(...Array.from(allTimestamps)));
  const maxDataTs = Math.min(endTimestamp, Math.max(...Array.from(allTimestamps)));

  const result: HourlyDataPoint[] = [];
  let lastExchange = { rate: 0, block: 0 };
  let lastBase = 0;
  let lastQuote = 0;
  let lastCg = 0;
  let lastBorrow = 0;

  for (const [, v] of exchangeMap) { lastExchange = v; break; }
  for (const [, v] of baseMap) { lastBase = v; break; }
  for (const [, v] of quoteMap) { lastQuote = v; break; }
  for (const [, v] of cgMap) { lastCg = v; break; }
  for (const [, v] of borrowMap) { lastBorrow = v; break; }

  for (let ts = minDataTs; ts <= maxDataTs; ts += intervalSeconds) {
    // For wider intervals, check the nearest hour-aligned key
    const hourKey = Math.floor(ts / 3600) * 3600;

    // Forward-fill: check this timestamp and all hourly keys between previous and current
    for (let checkTs = ts - intervalSeconds + 3600; checkTs <= ts; checkTs += 3600) {
      const ck = Math.floor(checkTs / 3600) * 3600;
      if (exchangeMap.has(ck)) lastExchange = exchangeMap.get(ck)!;
      if (baseMap.has(ck)) lastBase = baseMap.get(ck)!;
      if (quoteMap.has(ck)) lastQuote = quoteMap.get(ck)!;
      if (cgMap.has(ck)) lastCg = cgMap.get(ck)!;
      if (borrowMap.has(ck)) lastBorrow = borrowMap.get(ck)!;
    }

    if (exchangeMap.has(hourKey)) lastExchange = exchangeMap.get(hourKey)!;
    if (baseMap.has(hourKey)) lastBase = baseMap.get(hourKey)!;
    if (quoteMap.has(hourKey)) lastQuote = quoteMap.get(hourKey)!;
    if (cgMap.has(hourKey)) lastCg = cgMap.get(hourKey)!;
    if (borrowMap.has(hourKey)) lastBorrow = borrowMap.get(hourKey)!;

    if (lastExchange.rate === 0 || lastBase === 0 || lastQuote === 0 || lastBorrow === 0) {
      continue;
    }

    const oraclePrice =
      lastQuote > 0
        ? (lastExchange.rate * lastBase) / lastQuote
        : lastExchange.rate * lastBase;

    result.push({
      timestamp: hourKey,
      blockNumber: lastExchange.block,
      exchangeRate: lastExchange.rate,
      basePrice: lastBase,
      quotePrice: lastQuote,
      oraclePrice,
      coingeckoPrice: lastCg > 0 ? lastCg : oraclePrice,
      borrowApy: lastBorrow,
    });
  }

  return result;
}

// ── Client-side loader (runs in the browser) ────────────────────────

export async function loadBacktestDataClient(
  rpcUrl: string,
  marketUniqueKey: string,
  vaultAddress: string,
  startTimestamp: number,
  endTimestamp: number,
  onProgress?: (progress: LoadProgress) => void
): Promise<HourlyDataPoint[]> {
  const daysBack = Math.ceil((endTimestamp - startTimestamp) / 86400);
  const intervalSeconds = getIntervalSeconds(daysBack);
  const intervalLabel = intervalSeconds === 3600 ? "hourly" : `${intervalSeconds / 3600}h`;

  onProgress?.({
    stage: "blocks",
    message: `Resolving ${intervalLabel} blocks for ${daysBack} days...`,
    percent: 5,
  });

  const client = getClient(rpcUrl);
  const blocks = await resolveHourlyBlocks(client, startTimestamp, endTimestamp, intervalSeconds);

  console.log(`[Backtest] Resolved ${blocks.length} blocks (${intervalLabel} intervals for ${daysBack}d)`);

  onProgress?.({
    stage: "onchain",
    message: `Fetching on-chain data for ${blocks.length} blocks...`,
    percent: 15,
  });

  // Fetch all 3 data sources in parallel
  const [oracleSnapshots, coingeckoPrices, borrowRates] = await Promise.all([
    // On-chain: oracle snapshots (exchange rate + DAI/USD + USDT/USD per block)
    (async () => {
      const snapshots = await batchGetOracleSnapshots(client, vaultAddress, blocks);
      onProgress?.({
        stage: "onchain",
        message: `On-chain data: ${snapshots.length}/${blocks.length} blocks fetched`,
        percent: 60,
      });
      return snapshots;
    })(),
    // CoinGecko: off-chain price for deviation analysis
    (async () => {
      onProgress?.({
        stage: "coingecko",
        message: "Fetching CoinGecko prices...",
        percent: 20,
      });
      return fetchCoinGeckoHourly("susds", startTimestamp, endTimestamp);
    })(),
    // Morpho: borrow rates
    (async () => {
      onProgress?.({
        stage: "morpho",
        message: "Fetching Morpho borrow rates...",
        percent: 25,
      });
      return fetchMorphoHourlyBorrowRates(marketUniqueKey, startTimestamp, endTimestamp);
    })(),
  ]);

  console.log(
    `[Backtest] Raw data: ${oracleSnapshots.length} oracle snapshots, ${coingeckoPrices.length} CoinGecko, ${borrowRates.length} borrow rates`
  );

  onProgress?.({
    stage: "aligning",
    message: "Aligning data to time series...",
    percent: 85,
  });

  // Convert OracleSnapshot[] to the RawHistoricalData format
  const raw: RawHistoricalData = {
    exchangeRates: oracleSnapshots.map((s: OracleSnapshot) => ({
      timestamp: s.timestamp,
      blockNumber: s.blockNumber,
      rate: s.exchangeRate,
    })),
    basePrices: oracleSnapshots.map((s: OracleSnapshot) => ({
      timestamp: s.timestamp,
      price: s.basePrice,
    })),
    quotePrices: oracleSnapshots.map((s: OracleSnapshot) => ({
      timestamp: s.timestamp,
      price: s.quotePrice,
    })),
    coingeckoPrices,
    borrowRates,
  };

  const aligned = alignToHourlySeries(raw, startTimestamp, endTimestamp, intervalSeconds);

  console.log(`[Backtest] Aligned ${aligned.length} data points`);

  onProgress?.({
    stage: "done",
    message: `Loaded ${aligned.length} data points`,
    percent: 100,
  });

  return aligned;
}
