import { AssetConfig } from "./types";

// Aave V3 Ethereum borrow pool IDs (from DeFiLlama)
export const AAVE_V3_BORROW_POOLS: Record<string, string> = {
  USDC: "aa70268e-4b52-42bf-a116-608b370f9501",
  USDT: "f981a304-bb6c-45b8-b0c5-fd2f515ad23a",
  RLUSD: "85fc6934-c94d-4ebe-9c60-66beb363669f",
  PYUSD: "d118f505-e75f-4152-bad3-49a2dc7482bf",
};

// Aave Horizon borrow pool IDs
export const AAVE_HORIZON_BORROW_POOLS: Record<string, string> = {
  USDC: "27296bf9-617a-46e4-9d6d-eefc71e9e0b6",
  RLUSD: "98d07333-f5e4-4a48-8061-cfb4b73ccf79",
};

// Morpho collateral token addresses on Ethereum
export const MORPHO_COLLATERAL_ADDRESSES: Record<string, string> = {
  sUSDE: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
  syrupUSDC: "0x80ac24aA929eaF5013f6436cdA2a7ba190f5Cc0b",
  SyrupUSDT: "0x356B8d89c1e1239Cbbb9dE4815c39A1474d5BA7D",
  sUSDS: "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD",
  sNUSD: "0x08EFCC2F3e61185D0EA7F8830B3FEc9Bfa2EE313",
};

// Borrow asset addresses on Ethereum
export const BORROW_ASSET_ADDRESSES: Record<string, string> = {
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  PYUSD: "0x6c3ea9036406852006290770BEdFcAbA0e23A0e8",
  RLUSD: "0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD",
};

// Aave token addresses for link generation
export const AAVE_TOKEN_ADDRESSES: Record<string, string> = {
  USDC: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  USDT: "0xdac17f958d2ee523a2206206994597c13d831ec7",
  RLUSD: "0x8292bb45bf1ee4d140127049757c2e0ff06317ed",
  PYUSD: "0x6c3ea9036406852006290770bedfcaba0e23a0e8",
};

export const ASSETS: AssetConfig[] = [
  {
    name: "sUSDE",
    displayName: "Ethena sUSDe",
    chain: "Ethereum",
    // DeFiLlama: project=ethena-usde, symbol=SUSDE, pool=66985a81-...
    baseYieldPoolIds: ["66985a81-9c51-46ca-9977-42b4fe7bc6df"],
    borrowVenues: [
      {
        venue: "Aave V3",
        borrowAssets: ["USDC", "USDT", "RLUSD", "PYUSD"],
        poolIds: AAVE_V3_BORROW_POOLS,
      },
      {
        venue: "Morpho",
        borrowAssets: ["USDC", "USDT", "RLUSD", "PYUSD"],
        morphoCollateralAddress: MORPHO_COLLATERAL_ADDRESSES.sUSDE,
      },
    ],
  },
  {
    name: "sUSDS",
    displayName: "Sky sUSDS",
    chain: "Ethereum",
    // DeFiLlama: project=sky-lending, symbol=SUSDS, pool=d8c4eff5-...
    baseYieldPoolIds: ["d8c4eff5-c8a9-46fc-a888-057c4c668e72"],
    borrowVenues: [
      {
        venue: "Morpho",
        borrowAssets: ["USDC", "USDT", "RLUSD", "PYUSD"],
        morphoCollateralAddress: MORPHO_COLLATERAL_ADDRESSES.sUSDS,
      },
    ],
  },
  {
    name: "syrupUSDC",
    displayName: "Maple syrupUSDC",
    chain: "Ethereum",
    // DeFiLlama: project=maple, symbol=USDC, poolMeta="Syrup USDC", pool=43641cf5-...
    baseYieldPoolIds: ["43641cf5-a92e-416b-bce9-27113d3c0db6"],
    borrowVenues: [
      {
        venue: "Morpho",
        borrowAssets: ["USDC", "USDT", "RLUSD", "PYUSD"],
        morphoCollateralAddress: MORPHO_COLLATERAL_ADDRESSES.syrupUSDC,
      },
    ],
  },
  {
    name: "SyrupUSDT",
    displayName: "Maple SyrupUSDT",
    chain: "Ethereum",
    // DeFiLlama: project=maple, symbol=USDT, poolMeta="Syrup USDT", pool=8edfdf02-...
    baseYieldPoolIds: ["8edfdf02-cdbb-43f7-bca6-954e5fe56813"],
    borrowVenues: [
      {
        venue: "Aave V3",
        borrowAssets: ["USDC", "USDT", "RLUSD", "PYUSD"],
        poolIds: AAVE_V3_BORROW_POOLS,
      },
      {
        venue: "Morpho",
        borrowAssets: ["USDC", "USDT", "RLUSD", "PYUSD"],
        morphoCollateralAddress: MORPHO_COLLATERAL_ADDRESSES.SyrupUSDT,
      },
    ],
  },
  {
    name: "sNUSD",
    displayName: "Neutrl sNUSD",
    chain: "Ethereum",
    // sNUSD base yield not directly in DeFiLlama - may need manual fallback
    baseYieldProject: "neutrl",
    baseYieldSymbol: "SNUSD",
    manualBaseYield: 8.0, // Approximate from Pendle implied yield
    borrowVenues: [
      {
        venue: "Morpho",
        borrowAssets: ["USDC", "USDT", "RLUSD", "PYUSD"],
        morphoCollateralAddress: MORPHO_COLLATERAL_ADDRESSES.sNUSD,
      },
    ],
  },
  {
    name: "VBILL",
    displayName: "VanEck VBILL",
    chain: "Ethereum",
    // VBILL on Aave shows APY=0 in DeFiLlama (it's a T-bill fund, yield is off-chain)
    manualBaseYield: 4.25, // VanEck VBILL T-bill fund approximate yield
    borrowVenues: [
      {
        venue: "Aave Horizon",
        borrowAssets: ["USDC", "RLUSD"],
        poolIds: AAVE_HORIZON_BORROW_POOLS,
      },
    ],
  },
];
