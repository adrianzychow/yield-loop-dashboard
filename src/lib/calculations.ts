import { BorrowMarket } from "./types";

export function findCheapestBorrow(markets: BorrowMarket[]): BorrowMarket | null {
  if (markets.length === 0) return null;
  return markets.reduce((best, m) =>
    m.borrowRate < best.borrowRate ? m : best
  );
}

export function calcSpread(baseYield: number | null, borrowCost: number | null): number | null {
  if (baseYield === null || borrowCost === null) return null;
  return baseYield - borrowCost;
}

export function calcNetYield(baseYield: number | null, spread: number | null, leverage: number): number | null {
  if (baseYield === null || spread === null) return null;
  // Net = Base + Spread * (leverage - 1)
  return baseYield + spread * (leverage - 1);
}
