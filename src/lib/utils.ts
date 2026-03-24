export function formatPct(value: number | null | undefined): string {
  if (value === null || value === undefined) return "N/A";
  return `${value.toFixed(2)}%`;
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "N/A";
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

export function getAaveLink(borrowAsset: string, tokenAddress: string): string {
  return `https://app.aave.com/reserve-overview/?underlyingAsset=${tokenAddress}&marketName=proto_mainnet_v3`;
}

export function getMorphoLink(uniqueKey: string, collateralSymbol?: string, loanSymbol?: string): string {
  const slug = collateralSymbol && loanSymbol
    ? `/${collateralSymbol.toLowerCase()}-${loanSymbol.toLowerCase()}`
    : "";
  return `https://app.morpho.org/ethereum/market/${uniqueKey}${slug}`;
}

export function getHorizonLink(): string {
  return "https://horizon.aave.com/";
}

export function getEulerLink(): string {
  return "https://app.euler.finance/";
}
