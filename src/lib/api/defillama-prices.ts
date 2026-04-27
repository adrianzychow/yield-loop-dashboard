/**
 * DeFiLlama Coins API — historical price fetcher.
 *
 * Replaces CoinGecko for the oracle deviation analysis.  DeFiLlama aggregates
 * from on-chain DEX prices + CoinGecko, so recent data is more complete and
 * consistently hourly rather than switching to daily at the end of the window.
 *
 * Endpoint: https://coins.llama.fi/chart/{coins}
 *   ?start=<unix>  start timestamp
 *   &span=<N>       number of data points (optional — we use period instead)
 *   &period=1h      sampling period
 *   &searchWidth=600  seconds around each point to search for a price
 *
 * Rate limit: ~30 req/min on the public API — no key needed.
 */

const LLAMA_COINS_BASE = "https://coins.llama.fi";

// ── Coin identifiers used in this project ─────────────────────────

export const LLAMA_IDS = {
  sUSDS: "coingecko:susds",
  wstETH: "coingecko:wrapped-steth",
  WETH: "coingecko:weth",
} as const;

// ── Types ─────────────────────────────────────────────────────────

interface LlamaPricePoint {
  timestamp: number;
  price: number;
}

interface LlamaCoinChart {
  prices: LlamaPricePoint[];
  symbol: string;
  confidence: number;
}

interface LlamaChartResponse {
  coins: Record<string, LlamaCoinChart>;
}

// ── Chunked fetcher ───────────────────────────────────────────────

/** Maximum hours per request without exceeding DeFiLlama's point limit (~1000) */
const MAX_HOURS_PER_CHUNK = 700;

/**
 * Fetch hourly prices for a single coin from DeFiLlama Coins API.
 *
 * Automatically chunks long date ranges into multiple requests and
 * de-duplicates by hour key.
 *
 * @param coinId  e.g. "coingecko:susds" or "coingecko:wrapped-steth"
 * @param startTimestamp  Unix seconds
 * @param endTimestamp    Unix seconds
 * @param periodHours     Sampling period in hours (default 1). Use 4 for
 *                        ranges > 90 days to stay within point limits.
 */
export async function fetchLlamaHourly(
  coinId: string,
  startTimestamp: number,
  endTimestamp: number,
  periodHours = 1
): Promise<LlamaPricePoint[]> {
  const chunkSeconds = MAX_HOURS_PER_CHUNK * periodHours * 3600;
  const allPoints: LlamaPricePoint[] = [];

  let from = startTimestamp;
  while (from < endTimestamp) {
    const to = Math.min(from + chunkSeconds, endTimestamp);
    const span = Math.ceil((to - from) / (periodHours * 3600));

    const url = new URL(`${LLAMA_COINS_BASE}/chart/${encodeURIComponent(coinId)}`);
    url.searchParams.set("start", String(from));
    url.searchParams.set("span", String(span));
    url.searchParams.set("period", `${periodHours}h`);
    url.searchParams.set("searchWidth", "3600"); // search ±1h around each point

    try {
      const res = await fetch(url.toString(), {
        // DeFiLlama allows CORS from browsers
        headers: { Accept: "application/json" },
        // Server-side: no proxy needed. Client-side: DeFiLlama allows CORS.
      });

      if (!res.ok) {
        console.warn(`[DeFiLlama] ${coinId} chunk ${from}→${to} failed: ${res.status}`);
        from = to;
        continue;
      }

      const json: LlamaChartResponse = await res.json();
      const coin = json?.coins?.[coinId];
      if (coin?.prices) {
        allPoints.push(...coin.prices);
      }
    } catch (err) {
      console.warn(`[DeFiLlama] ${coinId} fetch error:`, (err as Error).message);
    }

    from = to;
    // Small delay between chunks to be polite to the API
    if (from < endTimestamp) {
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  // Deduplicate by hour bucket, keep latest value per bucket
  const byHour = new Map<number, LlamaPricePoint>();
  for (const p of allPoints) {
    const hourKey = Math.floor(p.timestamp / 3600) * 3600;
    byHour.set(hourKey, { timestamp: hourKey, price: p.price });
  }

  return Array.from(byHour.values()).sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Convenience: fetch multiple coins in parallel.
 */
export async function fetchLlamaHourlyMulti(
  coinIds: string[],
  startTimestamp: number,
  endTimestamp: number,
  periodHours = 1
): Promise<Record<string, LlamaPricePoint[]>> {
  const results = await Promise.all(
    coinIds.map((id) =>
      fetchLlamaHourly(id, startTimestamp, endTimestamp, periodHours)
    )
  );
  return Object.fromEntries(coinIds.map((id, i) => [id, results[i]]));
}
