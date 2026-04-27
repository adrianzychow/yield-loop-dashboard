/**
 * Hourly oracle ingestion job — runs via Vercel Cron.
 *
 * For each tracked asset (sUSDS, wstETH):
 *  1. Find the last stored timestamp (ingest_cursors)
 *  2. Resolve on-chain blocks for the missing period
 *  3. Fetch oracle snapshots from the archive node
 *  4. Fetch DeFiLlama prices for the period
 *  5. Fetch Morpho borrow rates for each tracked market
 *  6. Upsert all rows, advance the cursor
 *
 * Protected by CRON_SECRET (Vercel injects this automatically for cron
 * invocations; manual calls require Authorization: Bearer <CRON_SECRET>).
 *
 * Vercel Cron config (vercel.json):
 *   { "path": "/api/cron/ingest-oracle", "schedule": "0 * * * *" }
 *
 * Environment variables required (server-side only):
 *   POSTGRES_URL          — Neon connection string (set by Vercel Storage)
 *   ETH_RPC_URL           — Alchemy archive node (server-side)
 *   CRON_SECRET           — auto-set by Vercel for cron auth
 */

import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import {
  resolveHourlyBlocks,
  batchGetOracleSnapshots,
  SUSDS_VAULT,
} from "@/lib/backtester/onchain";
import { fetchCapoParams, fetchWstEthOracleAtBlock } from "@/lib/wsteth-oracle";
import { fetchLlamaHourly, LLAMA_IDS } from "@/lib/api/defillama-prices";
import {
  upsertOracleSnapshots,
  upsertBorrowRates,
  upsertDefiLlamaPrices,
  getIngestCursor,
  setIngestCursor,
  type OracleSnapshotRow,
} from "@/lib/db";

// ── Markets to ingest ─────────────────────────────────────────────

const MARKETS = [
  // sUSDS / USDT — largest Morpho market
  {
    asset: "sUSDS",
    marketKey: "0xb8fc70e82bc5bb53e773626fcc6a23f7eefa036918d7ef216ecfb1950a94a85e",
    source: "morpho",
    borrowAsset: "USDT",
  },
  // wstETH / WETH — largest Morpho market
  {
    asset: "wstETH",
    marketKey: "0xb8fc70e82bc5bb53e773626fcc6a23f7eefa036918d7ef216ecfb1950a94a85e",
    source: "morpho",
    borrowAsset: "WETH",
  },
  // wstETH / WETH Aave V3 — proxy via DeFiLlama
  {
    asset: "wstETH",
    marketKey: "aave-wsteth-eth",
    source: "defillama",
    borrowAsset: "WETH",
  },
];

const MORPHO_API = "https://blue-api.morpho.org/graphql";
const AAVE_V3_WETH_POOL = "e880e828-ca59-4ec6-8d4f-27182a4dc23d";

// ── Auth ──────────────────────────────────────────────────────────

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // dev — allow without secret
  const header = req.headers.get("authorization");
  return header === `Bearer ${secret}`;
}

// ── Morpho borrow rate fetcher ────────────────────────────────────

const MORPHO_QUERY = `
  query GetBorrowRates($uniqueKey: String!, $startTs: Int!, $endTs: Int!) {
    marketByUniqueKey(uniqueKey: $uniqueKey, chainId: 1) {
      historicalState {
        borrowApy(options: {
          startTimestamp: $startTs
          endTimestamp: $endTs
          interval: HOUR
        }) { x y }
      }
    }
  }
`;

async function fetchMorphoBorrowRates(
  marketKey: string,
  startTs: number,
  endTs: number
): Promise<{ ts: number; borrow_apy: number }[]> {
  const res = await fetch(MORPHO_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: MORPHO_QUERY,
      variables: { uniqueKey: marketKey, startTs, endTs },
    }),
  });
  const json = await res.json();
  const pts = json?.data?.marketByUniqueKey?.historicalState?.borrowApy ?? [];
  return pts.map((p: { x: number; y: number }) => ({
    ts: Math.floor(p.x / 3600) * 3600,
    borrow_apy: p.y,
  }));
}

async function fetchAaveBorrowRates(
  startTs: number,
  endTs: number
): Promise<{ ts: number; borrow_apy: number }[]> {
  const res = await fetch(`https://yields.llama.fi/chart/${AAVE_V3_WETH_POOL}`);
  const json = await res.json();
  const pts: { timestamp: string; apyBase: number | null }[] = json?.data ?? [];
  return pts
    .map((p) => ({
      ts: Math.floor(new Date(p.timestamp).getTime() / 1000 / 3600) * 3600,
      borrow_apy: (p.apyBase ?? 0) / 100,
    }))
    .filter((p) => p.ts >= startTs && p.ts <= endTs);
}

// ── wstETH oracle fetcher (server-side, batched) ──────────────────

async function ingestWstEthOracle(
  rpcUrl: string,
  fromTs: number,
  toTs: number
): Promise<OracleSnapshotRow[]> {
  const client = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl, { retryCount: 3, timeout: 30_000 }),
  });

  // Determine interval: 1h for <14d, 4h for longer
  const daysBack = (toTs - fromTs) / 86400;
  const interval = daysBack <= 14 ? 3600 : daysBack <= 45 ? 7200 : 14400;

  const blocks = await resolveHourlyBlocks(client, fromTs, toTs, interval);
  const capo = await fetchCapoParams(client);

  const rows: OracleSnapshotRow[] = [];
  const BATCH = 20;
  for (let i = 0; i < blocks.length; i += BATCH) {
    const batch = blocks.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async ({ timestamp, blockNumber }) => {
        const oracle = await fetchWstEthOracleAtBlock(
          client,
          BigInt(blockNumber),
          timestamp,
          capo
        );
        if (!oracle) return null;
        return {
          ts: Math.floor(timestamp / 3600) * 3600,
          block_number: blockNumber,
          exchange_rate: oracle.effectiveRatio,
          base_price: oracle.ethUsd,
          quote_price: 1.0,
          oracle_price: oracle.effectiveRatio * oracle.ethUsd,
        };
      })
    );
    for (const r of results) {
      if (r) rows.push(r);
    }
    if (i + BATCH < blocks.length) {
      await new Promise((res) => setTimeout(res, 200));
    }
  }
  return rows;
}

// ── sUSDS oracle fetcher (server-side) ───────────────────────────

async function ingestSUsdsOracle(
  rpcUrl: string,
  fromTs: number,
  toTs: number
): Promise<OracleSnapshotRow[]> {
  const client = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl, { retryCount: 3, timeout: 30_000 }),
  });
  const daysBack = (toTs - fromTs) / 86400;
  const interval = daysBack <= 14 ? 3600 : daysBack <= 45 ? 7200 : 14400;
  const blocks = await resolveHourlyBlocks(client, fromTs, toTs, interval);
  const snapshots = await batchGetOracleSnapshots(client, SUSDS_VAULT, blocks);
  return snapshots.map((s) => ({
    ts: Math.floor(s.timestamp / 3600) * 3600,
    block_number: s.blockNumber,
    exchange_rate: s.exchangeRate,
    base_price: s.basePrice,
    quote_price: s.quotePrice,
    oracle_price: s.quotePrice > 0
      ? (s.exchangeRate * s.basePrice) / s.quotePrice
      : s.exchangeRate * s.basePrice,
  }));
}

// ── Handler ───────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rpcUrl = process.env.ETH_RPC_URL;
  if (!rpcUrl) {
    return NextResponse.json({ error: "ETH_RPC_URL not set" }, { status: 500 });
  }

  const now = Math.floor(Date.now() / 1000);
  // Round down to the last complete hour
  const toTs = Math.floor(now / 3600) * 3600;
  // Look back at most 7 days per cron run (avoid overwhelming the RPC)
  const MAX_CATCHUP = 7 * 24 * 3600;

  const log: string[] = [];

  try {
    // ── sUSDS oracle ──
    {
      const cursorKey = "oracle:sUSDS";
      const lastTs = await getIngestCursor(cursorKey);
      const fromTs = lastTs > 0
        ? Math.min(lastTs + 3600, toTs)
        : toTs - MAX_CATCHUP;

      if (fromTs < toTs) {
        log.push(`sUSDS oracle: ${fromTs} → ${toTs}`);
        const rows = await ingestSUsdsOracle(rpcUrl, fromTs, toTs);
        await upsertOracleSnapshots("sUSDS", rows);
        await setIngestCursor(cursorKey, toTs);
        log.push(`  → ${rows.length} rows`);
      } else {
        log.push("sUSDS oracle: up to date");
      }
    }

    // ── wstETH oracle ──
    {
      const cursorKey = "oracle:wstETH";
      const lastTs = await getIngestCursor(cursorKey);
      const fromTs = lastTs > 0
        ? Math.min(lastTs + 3600, toTs)
        : toTs - MAX_CATCHUP;

      if (fromTs < toTs) {
        log.push(`wstETH oracle: ${fromTs} → ${toTs}`);
        const rows = await ingestWstEthOracle(rpcUrl, fromTs, toTs);
        await upsertOracleSnapshots("wstETH", rows);
        await setIngestCursor(cursorKey, toTs);
        log.push(`  → ${rows.length} rows`);
      } else {
        log.push("wstETH oracle: up to date");
      }
    }

    // ── DeFiLlama prices ──
    for (const [asset, coinId] of [
      ["sUSDS", LLAMA_IDS.sUSDS],
      ["wstETH", LLAMA_IDS.wstETH],
    ] as const) {
      const cursorKey = `price:${coinId}`;
      const lastTs = await getIngestCursor(cursorKey);
      const fromTs = lastTs > 0
        ? Math.min(lastTs + 3600, toTs)
        : toTs - MAX_CATCHUP;

      if (fromTs < toTs) {
        log.push(`DeFiLlama ${asset}: ${fromTs} → ${toTs}`);
        const prices = await fetchLlamaHourly(coinId, fromTs, toTs, 1);
        await upsertDefiLlamaPrices(coinId, prices.map((p) => ({ ts: p.timestamp, price: p.price })));
        await setIngestCursor(cursorKey, toTs);
        log.push(`  → ${prices.length} rows`);
      }
    }

    // ── Borrow rates ──
    for (const market of MARKETS) {
      const cursorKey = `borrow:${market.marketKey}`;
      const lastTs = await getIngestCursor(cursorKey);
      const fromTs = lastTs > 0
        ? Math.min(lastTs + 3600, toTs)
        : toTs - MAX_CATCHUP;

      if (fromTs >= toTs) {
        log.push(`borrow ${market.marketKey.slice(0, 8)}: up to date`);
        continue;
      }

      let rates: { ts: number; borrow_apy: number }[] = [];
      if (market.source === "morpho") {
        rates = await fetchMorphoBorrowRates(market.marketKey, fromTs, toTs);
      } else {
        rates = await fetchAaveBorrowRates(fromTs, toTs);
      }

      await upsertBorrowRates(market.marketKey, market.source, rates);
      await setIngestCursor(cursorKey, toTs);
      log.push(`borrow ${market.marketKey.slice(0, 8)}: ${rates.length} rows`);
    }

    return NextResponse.json({ ok: true, log, timestamp: toTs });
  } catch (err) {
    console.error("[ingest-oracle] error:", err);
    return NextResponse.json(
      { ok: false, error: (err as Error).message, log },
      { status: 500 }
    );
  }
}
