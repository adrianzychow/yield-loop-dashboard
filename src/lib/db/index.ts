/**
 * Database client — wraps @vercel/postgres.
 *
 * Vercel automatically injects POSTGRES_URL when you provision a Neon
 * database via the Vercel Storage tab. For local development, add it to
 * .env.local (use the non-pooled connection string for direct connections).
 *
 * Tables (see migrate.sql for full schema):
 *   oracle_snapshots    — hourly on-chain oracle components per asset
 *   borrow_rates        — hourly borrow APY per market
 *   defillama_prices    — hourly DeFiLlama coin prices (off-chain comparison)
 *   ingest_cursors      — tracks last-processed timestamp per asset/market
 */

import { sql } from "@vercel/postgres";
import type { HourlyDataPoint } from "@/lib/backtester/types";

export { sql };

// ── Types matching DB rows ────────────────────────────────────────

export interface OracleSnapshotRow {
  ts: number;
  block_number: number;
  exchange_rate: number;
  base_price: number;
  quote_price: number;
  oracle_price: number;
}

export interface BorrowRateRow {
  ts: number;
  borrow_apy: number;
}

export interface DefiLlamaPriceRow {
  ts: number;
  price: number;
}

// ── Read helpers ──────────────────────────────────────────────────

/**
 * Fetch pre-computed HourlyDataPoint rows from the DB for a given asset
 * and market (borrow rates joined by timestamp).
 *
 * Returns null if the DB has insufficient coverage (< 50% of expected
 * hourly points) so the caller can fall back to live RPC.
 */
export async function queryBacktestData(
  asset: string,
  marketKey: string,
  startTs: number,
  endTs: number,
  intervalSeconds = 3600
): Promise<HourlyDataPoint[] | null> {
  const expectedPoints = Math.floor((endTs - startTs) / intervalSeconds);
  if (expectedPoints === 0) return null;

  // Pull all three tables in parallel
  const [oracleRes, borrowRes, priceRes] = await Promise.all([
    sql<OracleSnapshotRow>`
      SELECT ts, block_number, exchange_rate, base_price, quote_price, oracle_price
      FROM oracle_snapshots
      WHERE asset = ${asset}
        AND ts >= ${startTs}
        AND ts <= ${endTs}
      ORDER BY ts ASC
    `,
    sql<BorrowRateRow>`
      SELECT ts, borrow_apy
      FROM borrow_rates
      WHERE market_key = ${marketKey}
        AND ts >= ${startTs}
        AND ts <= ${endTs}
      ORDER BY ts ASC
    `,
    sql<DefiLlamaPriceRow>`
      SELECT ts, price
      FROM defillama_prices
      WHERE coin_id = ${assetToLlamaId(asset)}
        AND ts >= ${startTs}
        AND ts <= ${endTs}
      ORDER BY ts ASC
    `,
  ]);

  const oracleRows = oracleRes.rows;

  // Coverage check — need at least 50% of expected points in oracle data
  if (oracleRows.length < expectedPoints * 0.5) {
    return null;
  }

  // Index borrow rates and prices by hour bucket for fast lookup
  const borrowMap = new Map<number, number>();
  for (const r of borrowRes.rows) {
    borrowMap.set(Math.floor(r.ts / 3600) * 3600, r.borrow_apy);
  }

  const priceMap = new Map<number, number>();
  for (const r of priceRes.rows) {
    priceMap.set(Math.floor(r.ts / 3600) * 3600, r.price);
  }

  // Forward-fill and assemble HourlyDataPoint[]
  const result: HourlyDataPoint[] = [];
  let lastBorrow = 0;
  let lastPrice = 0;

  for (const row of oracleRows) {
    const hourKey = Math.floor(row.ts / 3600) * 3600;
    if (borrowMap.has(hourKey)) lastBorrow = borrowMap.get(hourKey)!;
    if (priceMap.has(hourKey)) lastPrice = priceMap.get(hourKey)!;

    if (lastBorrow === 0) continue; // skip until we have a borrow rate

    result.push({
      timestamp: hourKey,
      blockNumber: row.block_number,
      exchangeRate: row.exchange_rate,
      basePrice: row.base_price,
      quotePrice: row.quote_price,
      oraclePrice: row.oracle_price,
      coingeckoPrice: lastPrice > 0 ? lastPrice : row.oracle_price,
      borrowApy: lastBorrow,
    });
  }

  return result.length > 0 ? result : null;
}

// ── Write helpers ─────────────────────────────────────────────────

export async function upsertOracleSnapshots(
  asset: string,
  rows: OracleSnapshotRow[]
) {
  if (rows.length === 0) return;
  // Batch insert in chunks to avoid parameter limits
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await Promise.all(
      chunk.map((r) =>
        sql`
          INSERT INTO oracle_snapshots (asset, ts, block_number, exchange_rate, base_price, quote_price, oracle_price)
          VALUES (${asset}, ${r.ts}, ${r.block_number}, ${r.exchange_rate}, ${r.base_price}, ${r.quote_price}, ${r.oracle_price})
          ON CONFLICT (asset, ts) DO UPDATE
            SET block_number  = EXCLUDED.block_number,
                exchange_rate = EXCLUDED.exchange_rate,
                base_price    = EXCLUDED.base_price,
                quote_price   = EXCLUDED.quote_price,
                oracle_price  = EXCLUDED.oracle_price
        `
      )
    );
  }
}

export async function upsertBorrowRates(
  marketKey: string,
  source: string,
  rows: BorrowRateRow[]
) {
  if (rows.length === 0) return;
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await Promise.all(
      chunk.map((r) =>
        sql`
          INSERT INTO borrow_rates (market_key, source, ts, borrow_apy)
          VALUES (${marketKey}, ${source}, ${r.ts}, ${r.borrow_apy})
          ON CONFLICT (market_key, ts) DO UPDATE
            SET borrow_apy = EXCLUDED.borrow_apy,
                source     = EXCLUDED.source
        `
      )
    );
  }
}

export async function upsertDefiLlamaPrices(
  coinId: string,
  rows: { ts: number; price: number }[]
) {
  if (rows.length === 0) return;
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await Promise.all(
      chunk.map((r) =>
        sql`
          INSERT INTO defillama_prices (coin_id, ts, price)
          VALUES (${coinId}, ${r.ts}, ${r.price})
          ON CONFLICT (coin_id, ts) DO UPDATE
            SET price = EXCLUDED.price
        `
      )
    );
  }
}

export async function getIngestCursor(key: string): Promise<number> {
  const res = await sql<{ last_ts: number }>`
    SELECT last_ts FROM ingest_cursors WHERE key = ${key}
  `;
  return res.rows[0]?.last_ts ?? 0;
}

export async function setIngestCursor(key: string, lastTs: number) {
  await sql`
    INSERT INTO ingest_cursors (key, last_ts)
    VALUES (${key}, ${lastTs})
    ON CONFLICT (key) DO UPDATE SET last_ts = EXCLUDED.last_ts, updated_at = NOW()
  `;
}

// ── Helpers ───────────────────────────────────────────────────────

function assetToLlamaId(asset: string): string {
  switch (asset) {
    case "sUSDS":  return "coingecko:susds";
    case "wstETH": return "coingecko:wrapped-steth";
    default:       return `coingecko:${asset.toLowerCase()}`;
  }
}
