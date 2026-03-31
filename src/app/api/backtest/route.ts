import { NextResponse } from "next/server";

// Data loading has been moved client-side to avoid Vercel serverless timeout limits.
// This route is kept as a stub for backwards compatibility.
export async function POST() {
  return NextResponse.json(
    { error: "Backtest data is now loaded client-side. Please update your client." },
    { status: 410 }
  );
}
