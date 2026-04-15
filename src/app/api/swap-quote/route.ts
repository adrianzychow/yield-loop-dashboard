import { NextRequest, NextResponse } from "next/server";

/**
 * Proxy for realistic aggregator swap quotes.
 *
 * Tries the 0x Swap API first (v2 `/price` endpoint), falling back to 1inch
 * if 0x doesn't have a key configured but 1inch does. Returning `available:
 * false` tells the client to degrade gracefully to on-chain Uniswap V3
 * QuoterV2 + Curve get_dy.
 *
 * Required query params: chainId, sellToken, buyToken, sellAmount (base units).
 */

type QuoteResponse = {
  available: boolean;
  source: "0x" | "1inch" | null;
  // Expected buyAmount in base units (string of integer)
  buyAmount?: string;
  // Aggregator's gas estimate (units), if reported
  estimatedGas?: string;
  // Price impact as a fraction (0.0042 = 0.42%) when the aggregator reports
  // it — not all endpoints do.
  priceImpact?: number;
  // Route / sources breakdown (opaque, for display only)
  sources?: unknown;
  error?: string;
};

async function quote0x(params: {
  chainId: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
}): Promise<QuoteResponse | null> {
  const key = process.env.ZEROEX_API_KEY;
  if (!key) return null;

  const url = new URL("https://api.0x.org/swap/allowance-holder/price");
  url.searchParams.set("chainId", params.chainId);
  url.searchParams.set("sellToken", params.sellToken);
  url.searchParams.set("buyToken", params.buyToken);
  url.searchParams.set("sellAmount", params.sellAmount);

  const res = await fetch(url.toString(), {
    headers: {
      "0x-api-key": key,
      "0x-version": "v2",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    return {
      available: false,
      source: null,
      error: `0x ${res.status}: ${text.slice(0, 200)}`,
    };
  }
  const json = await res.json();
  return {
    available: true,
    source: "0x",
    buyAmount: json.buyAmount,
    estimatedGas: json.gas ?? json.estimatedGas,
    priceImpact:
      typeof json.estimatedPriceImpact === "string"
        ? Number(json.estimatedPriceImpact) / 100
        : undefined,
    sources: json.route ?? json.sources ?? null,
  };
}

async function quote1inch(params: {
  chainId: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
}): Promise<QuoteResponse | null> {
  const key = process.env.ONEINCH_API_KEY;
  if (!key) return null;

  const url = new URL(
    `https://api.1inch.dev/swap/v6.0/${params.chainId}/quote`
  );
  url.searchParams.set("src", params.sellToken);
  url.searchParams.set("dst", params.buyToken);
  url.searchParams.set("amount", params.sellAmount);
  url.searchParams.set("includeGas", "true");
  url.searchParams.set("includeProtocols", "true");

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    return {
      available: false,
      source: null,
      error: `1inch ${res.status}: ${text.slice(0, 200)}`,
    };
  }
  const json = await res.json();
  return {
    available: true,
    source: "1inch",
    buyAmount: json.dstAmount ?? json.toAmount,
    estimatedGas: json.gas ? String(json.gas) : undefined,
    sources: json.protocols ?? null,
  };
}

export async function GET(req: NextRequest) {
  const chainId = req.nextUrl.searchParams.get("chainId") ?? "1";
  const sellToken = req.nextUrl.searchParams.get("sellToken");
  const buyToken = req.nextUrl.searchParams.get("buyToken");
  const sellAmount = req.nextUrl.searchParams.get("sellAmount");

  if (!sellToken || !buyToken || !sellAmount) {
    return NextResponse.json(
      { available: false, source: null, error: "Missing required params" },
      { status: 400 }
    );
  }

  const params = { chainId, sellToken, buyToken, sellAmount };

  try {
    const zeroEx = await quote0x(params);
    if (zeroEx?.available) {
      return NextResponse.json(zeroEx, {
        headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120" },
      });
    }

    const oneInch = await quote1inch(params);
    if (oneInch?.available) {
      return NextResponse.json(oneInch, {
        headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120" },
      });
    }

    // No aggregator available — either no API keys or both returned errors.
    const errors = [zeroEx?.error, oneInch?.error].filter(Boolean).join(" / ");
    return NextResponse.json({
      available: false,
      source: null,
      error: errors || "No aggregator API key configured (set ZEROEX_API_KEY or ONEINCH_API_KEY)",
    });
  } catch (err) {
    return NextResponse.json(
      {
        available: false,
        source: null,
        error: err instanceof Error ? err.message : "Proxy error",
      },
      { status: 502 }
    );
  }
}
