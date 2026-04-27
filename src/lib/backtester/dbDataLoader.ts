/**
 * DB-backed data loader for the backtester.
 *
 * Strategy:
 *  1. Ask the `/api/oracle-data` endpoint for pre-computed rows from Neon DB.
 *  2. If the DB has enough coverage (≥ 50% of expected hourly points), return
 *     the DB data immediately — no RPC calls needed.
 *  3. On a "miss" (DB too sparse) or a network/DB error, fall back to the
 *     existing client-side RPC loaders which query the Ethereum archive node
 *     directly from the browser.
 *
 * This lets the backtester feel instant once the cron job has backfilled the
 * DB, while still working in dev or for date ranges the cron hasn't reached.
 */

import type { HourlyDataPoint } from "./types";
import type { LoadProgress } from "./dataLoader";
import { loadBacktestDataClient } from "./dataLoader";
import { loadWstEthBacktestDataClient } from "./wstethDataLoader";

// ── Adaptive interval (mirrors both client loaders) ────────────────

function getIntervalSeconds(daysBack: number): number {
  if (daysBack <= 14) return 3600;
  if (daysBack <= 45) return 7200;
  if (daysBack <= 90) return 14400;
  return 21600;
}

// ── DB fetch helper ────────────────────────────────────────────────

async function fetchFromDb(
  asset: string,
  marketKey: string,
  startTs: number,
  endTs: number,
  interval: number
): Promise<HourlyDataPoint[] | null> {
  try {
    const params = new URLSearchParams({
      asset,
      marketKey,
      startTs: String(startTs),
      endTs: String(endTs),
      interval: String(interval),
    });

    const res = await fetch(`/api/oracle-data?${params.toString()}`);
    if (!res.ok) return null;

    const json = await res.json();
    if (!json.ok || json.source === "miss" || !json.data) return null;

    return json.data as HourlyDataPoint[];
  } catch {
    return null;
  }
}

// ── Stablecoin loader (sUSDS) ──────────────────────────────────────

export async function loadBacktestData(
  rpcUrl: string,
  marketUniqueKey: string,
  vaultAddress: string,
  startTimestamp: number,
  endTimestamp: number,
  onProgress?: (progress: LoadProgress) => void
): Promise<HourlyDataPoint[]> {
  const daysBack = Math.ceil((endTimestamp - startTimestamp) / 86400);
  const interval = getIntervalSeconds(daysBack);

  // 1 — Try DB first
  onProgress?.({
    stage: "blocks",
    message: "Checking database cache...",
    percent: 2,
  });

  const dbData = await fetchFromDb(
    "sUSDS",
    marketUniqueKey,
    startTimestamp,
    endTimestamp,
    interval
  );

  if (dbData && dbData.length > 0) {
    onProgress?.({
      stage: "done",
      message: `Loaded ${dbData.length} points from database`,
      percent: 100,
    });
    return dbData;
  }

  // 2 — Fall back to live RPC
  onProgress?.({
    stage: "blocks",
    message: "Database miss — fetching live from archive node...",
    percent: 3,
  });

  return loadBacktestDataClient(
    rpcUrl,
    marketUniqueKey,
    vaultAddress,
    startTimestamp,
    endTimestamp,
    onProgress
  );
}

// ── wstETH loader ─────────────────────────────────────────────────

export async function loadWstEthBacktestData(
  rpcUrl: string,
  marketUniqueKey: string,
  startTimestamp: number,
  endTimestamp: number,
  onProgress?: (progress: LoadProgress) => void
): Promise<HourlyDataPoint[]> {
  const daysBack = Math.ceil((endTimestamp - startTimestamp) / 86400);
  const interval = getIntervalSeconds(daysBack);

  // 1 — Try DB first
  onProgress?.({
    stage: "blocks",
    message: "Checking database cache...",
    percent: 2,
  });

  const dbData = await fetchFromDb(
    "wstETH",
    marketUniqueKey,
    startTimestamp,
    endTimestamp,
    interval
  );

  if (dbData && dbData.length > 0) {
    onProgress?.({
      stage: "done",
      message: `Loaded ${dbData.length} points from database`,
      percent: 100,
    });
    return dbData;
  }

  // 2 — Fall back to live RPC
  onProgress?.({
    stage: "blocks",
    message: "Database miss — fetching live from archive node...",
    percent: 3,
  });

  return loadWstEthBacktestDataClient(
    rpcUrl,
    marketUniqueKey,
    startTimestamp,
    endTimestamp,
    onProgress
  );
}
