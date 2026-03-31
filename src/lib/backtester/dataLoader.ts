/**
 * Data loader for backtester.
 * Fetches and aligns all historical data to hourly time series.
 *
 * Data sources (all on-chain via archive node RPC):
 * - sUSDS exchange rate: convertToAssets(1e18) on sUSDS vault
 * - DAI/USD price: Chainlink aggregator 0xAed0c384... (BASE_FEED_1 from oracle)
 * - USDT/USD price: Chainlink aggregator 0x3E7d1eAB... (QUOTE_FEED_1 from oracle)
 * - Borrow APY: Morpho GraphQL API (interval: HOUR)
 * - Oracle price: Computed from components per MorphoChainlinkOracleV2 logic
 */

import type { HourlyDataPoint, RawHistoricalData } from "./types";

const MORPHO_API = "https://blue-api.morpho.org/graphql";

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
        rate: p.y, // Already a decimal (e.g., 0.03 = 3%)
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

/**
 * Align all raw data series to common hourly timestamps using forward-fill.
 * Since exchange rates and Chainlink prices are all fetched at the same block
 * numbers, they're already aligned — but borrow rates from Morpho API may
 * have different timestamps, so we forward-fill those.
 */
export function alignToHourlySeries(
  raw: RawHistoricalData,
  startTimestamp: number,
  endTimestamp: number
): HourlyDataPoint[] {
  // Build lookup maps (keyed by hourly timestamp)
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

  const borrowMap = new Map<number, number>();
  for (const p of raw.borrowRates) {
    const hourKey = Math.floor(p.timestamp / 3600) * 3600;
    borrowMap.set(hourKey, p.rate);
  }

  // Find the actual data range
  const allTimestamps = new Set<number>();
  for (const k of exchangeMap.keys()) allTimestamps.add(k);
  for (const k of baseMap.keys()) allTimestamps.add(k);
  for (const k of quoteMap.keys()) allTimestamps.add(k);
  for (const k of borrowMap.keys()) allTimestamps.add(k);

  const minDataTs = Math.max(
    startTimestamp,
    Math.min(...Array.from(allTimestamps))
  );
  const maxDataTs = Math.min(endTimestamp, Math.max(...Array.from(allTimestamps)));

  // Generate hourly series with forward-fill
  const result: HourlyDataPoint[] = [];
  let lastExchange = { rate: 0, block: 0 };
  let lastBase = 0;
  let lastQuote = 0;
  let lastBorrow = 0;

  // Initialize from first available data
  for (const [, v] of exchangeMap) {
    lastExchange = v;
    break;
  }
  for (const [, v] of baseMap) {
    lastBase = v;
    break;
  }
  for (const [, v] of quoteMap) {
    lastQuote = v;
    break;
  }
  for (const [, v] of borrowMap) {
    lastBorrow = v;
    break;
  }

  for (let ts = minDataTs; ts <= maxDataTs; ts += 3600) {
    const hourKey = Math.floor(ts / 3600) * 3600;

    // Update with actual data if available (forward-fill otherwise)
    if (exchangeMap.has(hourKey)) lastExchange = exchangeMap.get(hourKey)!;
    if (baseMap.has(hourKey)) lastBase = baseMap.get(hourKey)!;
    if (quoteMap.has(hourKey)) lastQuote = quoteMap.get(hourKey)!;
    if (borrowMap.has(hourKey)) lastBorrow = borrowMap.get(hourKey)!;

    // Skip if we don't have initial data yet
    if (
      lastExchange.rate === 0 ||
      lastBase === 0 ||
      lastQuote === 0 ||
      lastBorrow === 0
    ) {
      continue;
    }

    // Compute oracle price: (exchangeRate × DAI/USD) / USDT/USD
    // This matches MorphoChainlinkOracleV2 logic exactly
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
      borrowApy: lastBorrow,
    });
  }

  return result;
}

// ── Main loader (client-side, calls API route) ──────────────────────

/**
 * Fetch all backtester data via the API route.
 * This is called from the browser; the heavy RPC work happens server-side.
 */
export async function fetchBacktestData(
  marketUniqueKey: string,
  collateralAsset: string,
  borrowAsset: string,
  vaultAddress: string,
  startTimestamp: number,
  endTimestamp: number
): Promise<HourlyDataPoint[]> {
  const res = await fetch("/api/backtest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      marketUniqueKey,
      collateralAsset,
      borrowAsset,
      vaultAddress,
      startTimestamp,
      endTimestamp,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Backtest data fetch failed: ${err}`);
  }

  const json = await res.json();
  return json.data as HourlyDataPoint[];
}

// ── Server-side loader (used by API route) ──────────────────────────

/**
 * Server-side: fetch all raw data and align to hourly series.
 * Called from the Next.js API route where we have access to RPC.
 *
 * All price data is sourced directly on-chain:
 * - sUSDS exchange rate: vault.convertToAssets(1e18) at each block
 * - DAI/USD: Chainlink BASE_FEED_1 latestRoundData at each block
 * - USDT/USD: Chainlink QUOTE_FEED_1 latestRoundData at each block
 * - Borrow APY: Morpho GraphQL API (only off-chain source)
 */
export async function loadBacktestDataServer(
  rpcUrl: string,
  marketUniqueKey: string,
  vaultAddress: string,
  startTimestamp: number,
  endTimestamp: number
): Promise<{ data: HourlyDataPoint[]; metadata: { totalPoints: number; dataGaps: number } }> {
  const {
    getClient,
    resolveHourlyBlocks,
    batchGetExchangeRates,
    batchGetChainlinkPrices,
    BASE_FEED,
    QUOTE_FEED,
  } = await import("./onchain");

  const client = getClient(rpcUrl);

  console.log(
    `[Backtest] Loading data from ${new Date(startTimestamp * 1000).toISOString()} to ${new Date(endTimestamp * 1000).toISOString()}`
  );

  // Step 1: Resolve hourly block numbers (fast — only 2 binary searches)
  console.log("[Backtest] Resolving hourly blocks...");
  const hourlyBlocks = await resolveHourlyBlocks(
    client,
    startTimestamp,
    endTimestamp
  );
  console.log(`[Backtest] Resolved ${hourlyBlocks.length} blocks`);

  // Step 2: Fetch all on-chain data in parallel + Morpho borrow rates
  console.log("[Backtest] Fetching on-chain data (exchange rates + Chainlink feeds) and Morpho borrow rates...");
  const [exchangeRates, chainlinkBase, chainlinkQuote, borrowRates] =
    await Promise.all([
      // sUSDS → USDS exchange rate from vault contract
      batchGetExchangeRates(client, vaultAddress, hourlyBlocks),
      // DAI/USD from Chainlink (BASE_FEED_1 of the oracle)
      batchGetChainlinkPrices(client, BASE_FEED, hourlyBlocks),
      // USDT/USD from Chainlink (QUOTE_FEED_1 of the oracle)
      batchGetChainlinkPrices(client, QUOTE_FEED, hourlyBlocks),
      // Morpho borrow APY (only off-chain data source)
      fetchMorphoHourlyBorrowRates(
        marketUniqueKey,
        startTimestamp,
        endTimestamp
      ),
    ]);

  console.log(
    `[Backtest] Raw data: ${exchangeRates.length} exchange rates, ${chainlinkBase.length} DAI/USD prices, ${chainlinkQuote.length} USDT/USD prices, ${borrowRates.length} borrow rates`
  );

  // Step 3: Convert Chainlink results to the expected format
  const basePrices = chainlinkBase.map((p) => ({
    timestamp: p.timestamp,
    price: p.price,
  }));
  const quotePrices = chainlinkQuote.map((p) => ({
    timestamp: p.timestamp,
    price: p.price,
  }));

  // Step 4: Align to hourly series
  const raw: RawHistoricalData = {
    exchangeRates,
    basePrices,
    quotePrices,
    borrowRates,
  };

  const aligned = alignToHourlySeries(raw, startTimestamp, endTimestamp);

  const expectedHours = Math.floor((endTimestamp - startTimestamp) / 3600);
  const dataGaps = Math.max(0, expectedHours - aligned.length);

  console.log(
    `[Backtest] Aligned ${aligned.length} hourly points, ${dataGaps} gaps`
  );

  return {
    data: aligned,
    metadata: {
      totalPoints: aligned.length,
      dataGaps,
    },
  };
}
