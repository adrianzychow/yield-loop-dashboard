import { NextRequest, NextResponse } from "next/server";
import { loadBacktestDataServer } from "@/lib/backtester/dataLoader";

// In-memory cache for expensive historical data
const dataCache = new Map<
  string,
  { data: unknown; ts: number }
>();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      marketUniqueKey,
      vaultAddress,
      startTimestamp,
      endTimestamp,
    } = body;

    if (!marketUniqueKey || !vaultAddress || !startTimestamp || !endTimestamp) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    const rpcUrl = process.env.ETH_RPC_URL;
    if (!rpcUrl) {
      return NextResponse.json(
        { error: "ETH_RPC_URL not configured" },
        { status: 500 }
      );
    }

    // Check cache
    const cacheKey = `${marketUniqueKey}-${startTimestamp}-${endTimestamp}`;
    const cached = dataCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      return NextResponse.json(cached.data);
    }

    // Fetch data server-side (heavy RPC + API calls)
    const result = await loadBacktestDataServer(
      rpcUrl,
      marketUniqueKey,
      vaultAddress,
      startTimestamp,
      endTimestamp
    );

    // Cache the result
    dataCache.set(cacheKey, { data: result, ts: Date.now() });

    return NextResponse.json(result);
  } catch (err) {
    console.error("[API /backtest] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
