/**
 * Data loader for backtester.
 * Fetches and aligns all historical data to hourly time series.
 *
 * Data sources:
 * - sUSDS exchange rate: Archive node RPC (convertToAssets at hourly blocks)
 * - DAI/USD price: Chainlink aggregator on-chain (BASE_FEED_1 from oracle)
 * - USDT/USD price: Chainlink aggregator on-chain (QUOTE_FEED_1 from oracle)
 * - sUSDS/USD off-chain price: CoinGecko (for oracle deviation analysis only)
 * - Borrow APY: Morpho GraphQL API (interval: HOUR)
 * - Oracle price: Computed from on-chain components per MorphoChainlinkOracleV2
 */

import type { HourlyDataPoint, RawHistoricalData } from "./types";

const MORPHO_API = "https://blue-api.morpho.org/graphql";

// ── CoinGecko (off-chain comparison only) ───────────────────────────

/**
 * Fetch hourly sUSDS prices from CoinGecko in 90-day chunks.
 * Used only for oracle vs off-chain deviation analysis, NOT for the oracle itself.
 */
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
    await new Promise((r) => setTimeout(r, 1500));
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
  endTimestamp: number
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

  for (let ts = minDataTs; ts <= maxDataTs; ts += 3600) {
    const hourKey = Math.floor(ts / 3600) * 3600;

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
      coingeckoPrice: lastCg > 0 ? lastCg : oraclePrice, // fallback to oracle if CG missing
      borrowApy: lastBorrow,
    });
  }

  return result;
}

// ── Client-side fetcher ─────────────────────────────────────────────

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

// ── Server-side loader ──────────────────────────────────────────────

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

  // Step 1: Resolve hourly block numbers
  console.log("[Backtest] Resolving hourly blocks...");
  const hourlyBlocks = await resolveHourlyBlocks(client, startTimestamp, endTimestamp);
  console.log(`[Backtest] Resolved ${hourlyBlocks.length} blocks`);

  // Step 2: Fetch all data in parallel
  console.log("[Backtest] Fetching on-chain data + CoinGecko comparison + Morpho borrow rates...");
  const [exchangeRates, chainlinkBase, chainlinkQuote, coingeckoPrices, borrowRates] =
    await Promise.all([
      batchGetExchangeRates(client, vaultAddress, hourlyBlocks),
      batchGetChainlinkPrices(client, BASE_FEED, hourlyBlocks),
      batchGetChainlinkPrices(client, QUOTE_FEED, hourlyBlocks),
      // CoinGecko sUSDS price for deviation analysis
      fetchCoinGeckoHourly("susds", startTimestamp, endTimestamp),
      fetchMorphoHourlyBorrowRates(marketUniqueKey, startTimestamp, endTimestamp),
    ]);

  console.log(
    `[Backtest] Raw data: ${exchangeRates.length} exchange rates, ${chainlinkBase.length} DAI/USD, ${chainlinkQuote.length} USDT/USD, ${coingeckoPrices.length} CoinGecko, ${borrowRates.length} borrow rates`
  );

  const basePrices = chainlinkBase.map((p) => ({ timestamp: p.timestamp, price: p.price }));
  const quotePrices = chainlinkQuote.map((p) => ({ timestamp: p.timestamp, price: p.price }));

  const raw: RawHistoricalData = {
    exchangeRates,
    basePrices,
    quotePrices,
    coingeckoPrices,
    borrowRates,
  };

  const aligned = alignToHourlySeries(raw, startTimestamp, endTimestamp);
  const expectedHours = Math.floor((endTimestamp - startTimestamp) / 3600);
  const dataGaps = Math.max(0, expectedHours - aligned.length);

  console.log(`[Backtest] Aligned ${aligned.length} hourly points, ${dataGaps} gaps`);

  return {
    data: aligned,
    metadata: { totalPoints: aligned.length, dataGaps },
  };
}
