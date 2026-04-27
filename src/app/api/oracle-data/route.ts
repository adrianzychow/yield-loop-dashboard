/**
 * Read endpoint — serves pre-computed HourlyDataPoint[] from the Neon DB.
 *
 * Query params:
 *   asset        — "sUSDS" | "wstETH"
 *   marketKey    — Morpho uniqueKey or "aave-wsteth-eth"
 *   startTs      — Unix seconds
 *   endTs        — Unix seconds
 *   interval     — optional, seconds between points (default 3600)
 *
 * Returns:
 *   { ok: true, data: HourlyDataPoint[], source: "db" }
 *   { ok: false, error: string }           — missing params or DB error
 *   { ok: true, data: null, source: "miss" } — not enough DB coverage
 */

import { NextRequest, NextResponse } from "next/server";
import { queryBacktestData } from "@/lib/db";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;

  const asset     = searchParams.get("asset");
  const marketKey = searchParams.get("marketKey");
  const startTs   = Number(searchParams.get("startTs"));
  const endTs     = Number(searchParams.get("endTs"));
  const interval  = Number(searchParams.get("interval") ?? "3600");

  if (!asset || !marketKey || !startTs || !endTs) {
    return NextResponse.json(
      { ok: false, error: "Missing required params: asset, marketKey, startTs, endTs" },
      { status: 400 }
    );
  }

  if (startTs >= endTs) {
    return NextResponse.json(
      { ok: false, error: "startTs must be less than endTs" },
      { status: 400 }
    );
  }

  try {
    const data = await queryBacktestData(
      asset,
      marketKey,
      startTs,
      endTs,
      interval > 0 ? interval : 3600
    );

    if (data === null) {
      // DB miss — tell the client to fall back to live RPC
      return NextResponse.json({ ok: true, data: null, source: "miss" });
    }

    return NextResponse.json({ ok: true, data, source: "db" });
  } catch (err) {
    console.error("[oracle-data] DB error:", err);
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
