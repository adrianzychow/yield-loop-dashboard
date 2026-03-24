import { MorphoMarket, BorrowMarket } from "../types";
import { BORROW_ASSET_ADDRESSES, MORPHO_COLLATERAL_ADDRESSES } from "../constants";
import { getMorphoLink } from "../utils";

const MORPHO_API = "https://blue-api.morpho.org/graphql";

const QUERY = `
  query GetMarkets($collateralAddresses: [String!]!, $loanAddresses: [String!]!) {
    markets(
      first: 200
      where: {
        chainId_in: [1]
        collateralAssetAddress_in: $collateralAddresses
        loanAssetAddress_in: $loanAddresses
      }
    ) {
      items {
        uniqueKey
        loanAsset {
          symbol
          address
        }
        collateralAsset {
          symbol
          address
        }
        state {
          borrowApy
          supplyApy
          liquidityAssetsUsd
        }
        lltv
      }
    }
  }
`;

let morphoCache: { data: MorphoMarket[]; ts: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000;

export async function fetchMorphoMarkets(): Promise<MorphoMarket[]> {
  if (morphoCache && Date.now() - morphoCache.ts < CACHE_TTL) {
    return morphoCache.data;
  }

  const collateralAddresses = Object.values(MORPHO_COLLATERAL_ADDRESSES);
  const loanAddresses = Object.values(BORROW_ASSET_ADDRESSES);

  const res = await fetch(MORPHO_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: QUERY,
      variables: { collateralAddresses, loanAddresses },
    }),
  });

  const json = await res.json();
  const items: MorphoMarket[] = json?.data?.markets?.items ?? [];
  morphoCache = { data: items, ts: Date.now() };
  return items;
}

/**
 * Get Morpho borrow markets for a specific collateral asset
 */
export function getMorphoBorrowMarkets(
  allMarkets: MorphoMarket[],
  assetName: string,
  collateralAddress: string
): BorrowMarket[] {
  const markets: BorrowMarket[] = [];

  const filtered = allMarkets.filter(
    (m) =>
      m.collateralAsset.address.toLowerCase() ===
      collateralAddress.toLowerCase()
  );

  for (const m of filtered) {
    const borrowRate = m.state.borrowApy !== null ? m.state.borrowApy * 100 : null;
    if (borrowRate === null) continue;

    const liquidity = m.state.liquidityAssetsUsd ?? 0;

    // Skip markets with negligible liquidity (< $1000)
    if (liquidity < 1000) continue;

    markets.push({
      venue: "Morpho",
      pair: `${assetName}/${m.loanAsset.symbol}`,
      borrowAsset: m.loanAsset.symbol,
      borrowRate,
      liquidity,
      link: getMorphoLink(
        m.uniqueKey,
        m.collateralAsset.symbol,
        m.loanAsset.symbol
      ),
    });
  }

  return markets;
}
