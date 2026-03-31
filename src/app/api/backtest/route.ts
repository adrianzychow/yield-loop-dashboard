import { NextRequest, NextResponse } from "next/server";

/**
 * Proxy for CoinGecko API calls from the client.
 * CoinGecko's free API blocks browser CORS, so we proxy through the server.
 */
export async function GET(req: NextRequest) {
  const cgUrl = req.nextUrl.searchParams.get("cgUrl");

  if (!cgUrl || !cgUrl.startsWith("https://api.coingecko.com/")) {
    return NextResponse.json({ error: "Invalid CoinGecko URL" }, { status: 400 });
  }

  try {
    const res = await fetch(cgUrl);
    const data = await res.json();
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=7200" },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "CoinGecko fetch failed" },
      { status: 502 }
    );
  }
}

// Keep POST stub for backwards compatibility
export async function POST() {
  return NextResponse.json(
    { error: "Backtest data is now loaded client-side. Use GET for CoinGecko proxy." },
    { status: 410 }
  );
}
