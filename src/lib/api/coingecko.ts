import { CoinGeckoPricePoint } from "../types";

export const COINGECKO_IDS: Record<string, string> = {
  sUSDE: "ethena-staked-usde",
  sUSDS: "susds",
  syrupUSDC: "syrupusdc",
  SyrupUSDT: "syrupusdt",
  VBILL: "vaneck-treasury-fund",
  sNUSD: "snusd",
  USDC: "usd-coin",
  USDT: "tether",
  PYUSD: "paypal-usd",
  RLUSD: "ripple-usd",
  wstETH: "wrapped-steth",
  WETH: "weth",
};

let priceCache: { data: Record<string, number>; ts: number } | null = null;
const CACHE_TTL = 2 * 60 * 1000;

export async function fetchTokenPrices(): Promise<Record<string, number>> {
  if (priceCache && Date.now() - priceCache.ts < CACHE_TTL) {
    return priceCache.data;
  }

  const ids = Object.values(COINGECKO_IDS).join(",");
  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`
  );
  const json = await res.json();

  const prices: Record<string, number> = {};
  for (const [symbol, cgId] of Object.entries(COINGECKO_IDS)) {
    prices[symbol] = json[cgId]?.usd ?? 1.0;
  }

  priceCache = { data: prices, ts: Date.now() };
  return prices;
}

export function getTokenPrice(
  prices: Record<string, number>,
  symbol: string
): number {
  return prices[symbol] ?? 1.0;
}

export async function fetchPriceHistory(
  assetName: string,
  days: number
): Promise<CoinGeckoPricePoint[]> {
  const cgId = COINGECKO_IDS[assetName];
  if (!cgId) return [];

  const res = await fetch(
    `https://api.coingecko.com/api/v3/coins/${cgId}/market_chart?vs_currency=usd&days=${days}`
  );
  if (!res.ok) return [];
  const json = await res.json();
  return (json.prices ?? []).map(([ts, price]: [number, number]) => ({
    timestamp: ts,
    price,
  }));
}
