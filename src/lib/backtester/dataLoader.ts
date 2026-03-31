/**
 * Data loader for backtester.
 * Fetches and aligns all historical data to hourly time series.
 *
 * Data sources:
 * - sUSDS exchange rate: Archive node RPC (convertToAssets at hourly blocks)
 * - USDS/USD price: CoinGecko hourly (90-day chunks)
 * - USDT/USD price: CoinGecko hourly (90-day chunks)
 * - Borrow APY: Morpho GraphQL API (interval: HOUR)
 * - Oracle price: Computed from components
 */

import type { HourlyDataPoint, RawHistoricalData } from "./types";

const MORPHO_API = "https://blue-api.morpho.org/graphql";

// ── CoinGecko hourly prices ─────────────────────────────────────────

/**
 * Fetch hourly prices from CoinGecko in 90-day chunks.
 * CoinGecko returns hourly data automatically for ranges <= 90 days.
 */
async function fetchCoinGeckoHourly(
  cgId: string,
  startTimestamp: number,
  endTimestamp: number
): Promise<{ timestamp: number; price: number }[]> {
  const CHUNK_DAYS = 89; // Slightly under 90 to ensure hourly granularity
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
          timestamp: Math.floor(ts / 1000), // ms → seconds
          price,
        })
      );
      allPrices.push(...prices);
    } catch (err) {
      console.warn(`CoinGecko ${cgId} fetch error:`, err);
    }

    from = to;

    // Rate limit: CoinGecko free tier is ~10-30 req/min
    await new Promise((r) => setTimeout(r, 1500));
  }

  // Deduplicate by rounding to nearest hour
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

  // Find the actual data range (intersection of all series)
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

    // Compute oracle price: (exchangeRate × USDS/USD) / USDT/USD
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
 */
export async function loadBacktestDataServer(
  rpcUrl: string,
  marketUniqueKey: string,
  vaultAddress: string,
  startTimestamp: number,
  endTimestamp: number
): Promise<{ data: HourlyDataPoint[]; metadata: { totalPoints: number; dataGaps: number } }> {
  // Dynamic import to avoid bundling viem on client
  const { getClient, resolveHourlyBlocks, batchGetExchangeRates } =
    await import("./onchain");

  const client = getClient(rpcUrl);

  console.log(
    `[Backtest] Loading data from ${new Date(startTimestamp * 1000).toISOString()} to ${new Date(endTimestamp * 1000).toISOString()}`
  );

  // Step 1: Resolve hourly block numbers
  console.log("[Backtest] Resolving hourly blocks...");
  const hourlyBlocks = await resolveHourlyBlocks(
    client,
    startTimestamp,
    endTimestamp
  );
  console.log(`[Backtest] Resolved ${hourlyBlocks.length} blocks`);

  // Step 2: Fetch all data in parallel
  console.log("[Backtest] Fetching exchange rates, prices, and borrow rates...");
  const [exchangeRates, basePrices, quotePrices, borrowRates] =
    await Promise.all([
      // sUSDS exchange rate from archive node
      batchGetExchangeRates(client, vaultAddress, hourlyBlocks),
      // USDS/USD from CoinGecko
      fetchCoinGeckoHourly("usds", startTimestamp, endTimestamp),
      // USDT/USD from CoinGecko
      fetchCoinGeckoHourly("tether", startTimestamp, endTimestamp),
      // Morpho borrow APY
      fetchMorphoHourlyBorrowRates(
        marketUniqueKey,
        startTimestamp,
        endTimestamp
      ),
    ]);

  console.log(
    `[Backtest] Raw data: ${exchangeRates.length} exchange rates, ${basePrices.length} base prices, ${quotePrices.length} quote prices, ${borrowRates.length} borrow rates`
  );

  // Step 3: Align to hourly series
  const raw: RawHistoricalData = {
    exchangeRates,
    basePrices,
    quotePrices,
    borrowRates,
  };

  const aligned = alignToHourlySeries(raw, startTimestamp, endTimestamp);

  // Count gaps (hours where we had to forward-fill all values)
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
