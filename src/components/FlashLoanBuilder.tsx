"use client";

import { useState, useMemo } from "react";
import { ASSETS, MORPHO_COLLATERAL_ADDRESSES, BORROW_ASSET_ADDRESSES } from "@/lib/constants";
import { StrategyRow, MorphoMarket, DefiLlamaBorrowPool } from "@/lib/types";
import { formatUsd } from "@/lib/utils";

interface FlashLoanBuilderProps {
  strategies: StrategyRow[];
  morphoMarkets: MorphoMarket[];
  borrowPools: DefiLlamaBorrowPool[];
}

// Flash loan provider fee schedules (bps)
const FLASH_PROVIDERS = [
  { name: "Balancer (free)", feeBps: 0 },
  { name: "Aave V3 (0.05%)", feeBps: 5 },
  { name: "Morpho Flash (free)", feeBps: 0 },
];

// Supported DEX aggregators and their typical slippage tolerance
const DEX_AGGREGATORS = [
  { name: "1inch", typicalSlippageBps: 5 },
  { name: "Paraswap", typicalSlippageBps: 5 },
  { name: "Uniswap V3 (direct)", typicalSlippageBps: 10 },
  { name: "CowSwap", typicalSlippageBps: 3 },
];

interface TxStep {
  step: number;
  action: string;
  description: string;
  amountLabel: string;
  protocol: string;
  highlight?: "green" | "amber" | "red" | "blue" | "purple";
}

interface SimResult {
  flashLoanAmount: number;
  totalCollateral: number;
  totalBorrow: number;
  flashFeeUsd: number;
  swapSlippageUsd: number;
  totalEntryCost: number;
  netCollateralDeposited: number;
  effectiveLeverage: number;
  steps: TxStep[];
}

export default function FlashLoanBuilder({
  strategies,
  morphoMarkets,
}: FlashLoanBuilderProps) {
  const [collateral, setCollateral] = useState(ASSETS[0].name);
  const [borrowAsset, setBorrowAsset] = useState("USDC");
  const [venue, setVenue] = useState("Morpho");
  const [amount, setAmount] = useState(100_000);
  const [targetLeverage, setTargetLeverage] = useState(3.0);
  const [flashProviderIdx, setFlashProviderIdx] = useState(0);
  const [dexIdx, setDexIdx] = useState(0);
  const [collateralPrice, setCollateralPrice] = useState(1.0);
  const [showCalldata, setShowCalldata] = useState(false);

  const strategy = strategies.find((s) => s.asset.name === collateral);

  // Available borrow assets for this strategy + venue
  const availableBorrowAssets = useMemo(() => {
    if (!strategy) return ["USDC"];
    const venueConfig = strategy.asset.borrowVenues.find((v) => v.venue === venue);
    return venueConfig?.borrowAssets ?? ["USDC"];
  }, [strategy, venue]);

  // Available venues for this collateral
  const availableVenues = useMemo(() => {
    if (!strategy) return [];
    return strategy.asset.borrowVenues.map((v) => v.venue);
  }, [strategy]);

  // Reset borrow asset when venue/collateral changes
  useMemo(() => {
    if (!availableBorrowAssets.includes(borrowAsset)) {
      setBorrowAsset(availableBorrowAssets[0] ?? "USDC");
    }
  }, [availableBorrowAssets, borrowAsset]);

  // Current borrow rate from live data
  const currentBorrowRate = useMemo(() => {
    if (!strategy) return null;
    const bm = strategy.allBorrowMarkets.find(
      (m) => m.venue === venue && m.borrowAsset === borrowAsset
    );
    return bm?.borrowRate ?? null; // already in %
  }, [strategy, venue, borrowAsset]);

  // Liquidation LTV
  const liquidationLtv = useMemo(() => {
    if (venue === "Morpho") {
      const asset = ASSETS.find((a) => a.name === collateral);
      const collateralAddr = asset?.borrowVenues
        .find((v) => v.venue === "Morpho")
        ?.morphoCollateralAddress?.toLowerCase();
      const mm = morphoMarkets.find(
        (m) =>
          m.collateralAsset.address.toLowerCase() === collateralAddr &&
          m.loanAsset.symbol === borrowAsset &&
          (m.state.liquidityAssetsUsd ?? 0) >= 1000
      );
      if (mm) return parseInt(mm.lltv) / 1e18;
    }
    if (venue === "Aave Horizon") return 0.77;
    return 0.865; // Aave V3 default
  }, [collateral, venue, borrowAsset, morphoMarkets]);

  const maxLeverage = 1 / (1 - liquidationLtv);
  const cappedLeverage = Math.min(targetLeverage, maxLeverage - 0.01);
  const flashProvider = FLASH_PROVIDERS[flashProviderIdx];
  const dex = DEX_AGGREGATORS[dexIdx];

  const sim = useMemo<SimResult | null>(() => {
    if (cappedLeverage <= 1) return null;

    // Flash loan = (leverage - 1) × starting capital
    const flashLoanAmount = (cappedLeverage - 1) * amount;
    const flashFeeUsd = (flashProvider.feeBps / 10_000) * flashLoanAmount;

    // Swap borrowed stablecoins → collateral (one single swap in flash loan)
    const swapSlippageUsd = (dex.typicalSlippageBps / 10_000) * flashLoanAmount;

    // Collateral received after slippage
    const collateralFromSwap = (flashLoanAmount - swapSlippageUsd) / collateralPrice;
    const ownCollateral = amount / collateralPrice;
    const totalCollateralUnits = ownCollateral + collateralFromSwap;
    const netCollateralDeposited = totalCollateralUnits * collateralPrice;

    // Total borrow needed = flash loan principal + fee
    const totalBorrow = flashLoanAmount + flashFeeUsd;

    // Effective leverage after costs
    const effectiveLeverage = netCollateralDeposited / amount;

    // Total one-time entry cost
    const totalEntryCost = flashFeeUsd + swapSlippageUsd;

    const collateralSymbol = ASSETS.find((a) => a.name === collateral)?.displayName ?? collateral;
    const steps: TxStep[] = [
      {
        step: 1,
        action: "Flash Borrow",
        description: `Borrow ${borrowAsset} from ${flashProvider.name.split(" ")[0]}`,
        amountLabel: formatUsd(flashLoanAmount),
        protocol: flashProvider.name.split(" ")[0],
        highlight: "blue",
      },
      {
        step: 2,
        action: "Swap",
        description: `Swap ${borrowAsset} → ${collateral} via ${dex.name}`,
        amountLabel: `${formatUsd(flashLoanAmount)} → ${formatUsd(flashLoanAmount - swapSlippageUsd)} (−${dex.typicalSlippageBps} bps)`,
        protocol: dex.name,
        highlight: "purple",
      },
      {
        step: 3,
        action: "Deposit",
        description: `Deposit own ${collateral} + swapped ${collateral} as collateral on ${venue}`,
        amountLabel: `${formatUsd(amount)} own + ${formatUsd(flashLoanAmount - swapSlippageUsd)} = ${formatUsd(netCollateralDeposited)}`,
        protocol: venue,
        highlight: "green",
      },
      {
        step: 4,
        action: "Borrow",
        description: `Borrow ${borrowAsset} against collateral (LTV ≤ ${(liquidationLtv * 100).toFixed(0)}%)`,
        amountLabel: formatUsd(totalBorrow),
        protocol: venue,
        highlight: "amber",
      },
      {
        step: 5,
        action: "Repay Flash",
        description: `Repay flash loan principal${flashFeeUsd > 0 ? ` + fee (${flashProvider.feeBps} bps)` : " (no fee)"}`,
        amountLabel: `${formatUsd(flashLoanAmount)} + ${formatUsd(flashFeeUsd)} fee`,
        protocol: flashProvider.name.split(" ")[0],
        highlight: flashFeeUsd > 0 ? "red" : "green",
      },
    ];

    return {
      flashLoanAmount,
      totalCollateral: netCollateralDeposited,
      totalBorrow,
      flashFeeUsd,
      swapSlippageUsd,
      totalEntryCost,
      netCollateralDeposited,
      effectiveLeverage,
      steps,
    };
  }, [
    cappedLeverage,
    amount,
    flashProvider,
    dex,
    collateralPrice,
    borrowAsset,
    collateral,
    venue,
    liquidationLtv,
  ]);

  // Pseudo-calldata display
  const pseudoCalldata = useMemo(() => {
    if (!sim) return "";
    const collateralAddr = MORPHO_COLLATERAL_ADDRESSES[collateral] ?? "0x…";
    const borrowAddr = BORROW_ASSET_ADDRESSES[borrowAsset] ?? "0x…";
    return `// Flash Loan Transaction (pseudo-calldata)
// Provider: ${flashProvider.name}
// DEX: ${dex.name}

flashLoan({
  token:  "${borrowAddr}",
  amount: ${sim.flashLoanAmount.toFixed(0)}, // ${formatUsd(sim.flashLoanAmount)} ${borrowAsset}
  callback: {
    swap({
      tokenIn:  "${borrowAddr}",
      tokenOut: "${collateralAddr}",
      amountIn: ${sim.flashLoanAmount.toFixed(0)},
      slippage: ${dex.typicalSlippageBps}, // bps
    }),
    deposit({
      market:    "${venue}",
      collateral:"${collateralAddr}",
      amount:    ${sim.netCollateralDeposited.toFixed(0)},
    }),
    borrow({
      market:    "${venue}",
      asset:     "${borrowAddr}",
      amount:    ${sim.totalBorrow.toFixed(0)},
    }),
    repayFlash({
      token:  "${borrowAddr}",
      amount: ${(sim.flashLoanAmount + sim.flashFeeUsd).toFixed(0)},
    }),
  }
})`;
  }, [sim, flashProvider, dex, collateral, borrowAsset, venue]);

  const highlightColors: Record<string, string> = {
    green: "border-emerald-600/50 bg-emerald-900/10",
    amber: "border-amber-600/50 bg-amber-900/10",
    red: "border-red-600/50 bg-red-900/10",
    blue: "border-blue-600/50 bg-blue-900/10",
    purple: "border-purple-600/50 bg-purple-900/10",
  };

  const highlightText: Record<string, string> = {
    green: "text-emerald-400",
    amber: "text-amber-400",
    red: "text-red-400",
    blue: "text-sky-400",
    purple: "text-purple-400",
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-2">
        <span className="text-2xl">⚡</span>
        <h2 className="text-xl font-bold text-white">Flash Loan TX Builder</h2>
      </div>
      <p className="text-gray-400 text-sm mb-8">
        Build a single-transaction looping position using a flash loan. Instead of looping
        manually N times, one flash-loan atomically deposits, borrows, swaps, and repays —
        reaching target leverage in a single block.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* ── Left: Configuration ─────────────────────────────────────────── */}
        <div className="space-y-5">
          <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">
            Configuration
          </h3>

          <FLField label="Collateral Asset">
            <select
              value={collateral}
              onChange={(e) => setCollateral(e.target.value)}
              className="input-field"
            >
              {ASSETS.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.displayName}
                </option>
              ))}
            </select>
          </FLField>

          <FLField label="Lending Venue">
            <select
              value={venue}
              onChange={(e) => setVenue(e.target.value)}
              className="input-field"
            >
              {availableVenues.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </FLField>

          <FLField label="Borrow Asset">
            <select
              value={borrowAsset}
              onChange={(e) => setBorrowAsset(e.target.value)}
              className="input-field"
            >
              {availableBorrowAssets.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </FLField>

          <FLField label="Flash Loan Provider">
            <select
              value={flashProviderIdx}
              onChange={(e) => setFlashProviderIdx(Number(e.target.value))}
              className="input-field"
            >
              {FLASH_PROVIDERS.map((p, i) => (
                <option key={p.name} value={i}>
                  {p.name}
                </option>
              ))}
            </select>
          </FLField>

          <FLField label="DEX / Aggregator">
            <select
              value={dexIdx}
              onChange={(e) => setDexIdx(Number(e.target.value))}
              className="input-field"
            >
              {DEX_AGGREGATORS.map((d, i) => (
                <option key={d.name} value={i}>
                  {d.name} (~{d.typicalSlippageBps} bps slippage)
                </option>
              ))}
            </select>
          </FLField>

          <FLField label="Position Size ($)">
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(Math.max(0, Number(e.target.value)))}
              className="input-field"
              min={0}
              step={1000}
            />
          </FLField>

          <FLField label="Collateral Token Price ($)">
            <input
              type="number"
              value={collateralPrice}
              onChange={(e) => setCollateralPrice(Math.max(0.0001, Number(e.target.value)))}
              className="input-field"
              min={0.0001}
              step={0.0001}
            />
          </FLField>

          <FLField
            label={`Target Leverage (${targetLeverage.toFixed(1)}x)`}
          >
            <input
              type="range"
              min={10}
              max={100}
              value={targetLeverage * 10}
              onChange={(e) => setTargetLeverage(Number(e.target.value) / 10)}
              className="w-full accent-sky-500"
            />
            <div className="flex justify-between text-xs text-gray-500 mt-1">
              <span>1.0x</span>
              <span className={targetLeverage >= maxLeverage ? "text-red-400" : ""}>
                Max at liq. LTV: {maxLeverage.toFixed(1)}x
              </span>
              <span>10.0x</span>
            </div>
          </FLField>

          {/* Live borrow rate */}
          {currentBorrowRate !== null && (
            <div className="bg-gray-800/40 rounded-lg p-3 border border-gray-700/40 text-sm">
              <span className="text-gray-400">Live borrow rate ({venue} — {borrowAsset}):</span>{" "}
              <span className="text-amber-300 font-mono font-semibold">
                {currentBorrowRate.toFixed(2)}%
              </span>
            </div>
          )}
        </div>

        {/* ── Right: Summary cards ─────────────────────────────────────────── */}
        <div className="space-y-5">
          <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">
            Summary
          </h3>

          {sim ? (
            <div className="grid grid-cols-2 gap-4">
              <FLCard label="Flash Loan Amount" value={formatUsd(sim.flashLoanAmount)} color="text-sky-400" />
              <FLCard label="Total Collateral" value={formatUsd(sim.totalCollateral)} color="text-emerald-400" />
              <FLCard label="Total Borrow" value={formatUsd(sim.totalBorrow)} color="text-amber-400" />
              <FLCard
                label="Effective Leverage"
                value={`${sim.effectiveLeverage.toFixed(2)}x`}
                color="text-white"
              />
              <FLCard
                label="Flash Fee"
                value={formatUsd(sim.flashFeeUsd)}
                color={sim.flashFeeUsd === 0 ? "text-emerald-400" : "text-red-400"}
              />
              <FLCard label="Swap Slippage" value={formatUsd(sim.swapSlippageUsd)} color="text-amber-400" />
              <FLCard
                label="Total Entry Cost"
                value={formatUsd(sim.totalEntryCost)}
                color={sim.totalEntryCost > amount * 0.01 ? "text-red-400" : "text-amber-300"}
                wide
              />
            </div>
          ) : (
            <div className="text-gray-500 text-center py-12">
              Set leverage &gt; 1× to see the flash loan summary
            </div>
          )}
        </div>
      </div>

      {/* ── Transaction Steps ────────────────────────────────────────────────── */}
      {sim && (
        <div className="mt-10">
          <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-4">
            Transaction Steps (single atomic tx)
          </h3>
          <div className="space-y-3">
            {sim.steps.map((s) => (
              <div
                key={s.step}
                className={`rounded-xl border p-4 flex items-start gap-4 ${
                  highlightColors[s.highlight ?? "green"]
                }`}
              >
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${
                    highlightText[s.highlight ?? "green"]
                  } bg-gray-900/60 border border-gray-700`}
                >
                  {s.step}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={`text-sm font-semibold ${highlightText[s.highlight ?? "green"]}`}
                    >
                      {s.action}
                    </span>
                    <span className="text-xs text-gray-500 bg-gray-800 rounded px-2 py-0.5">
                      {s.protocol}
                    </span>
                  </div>
                  <div className="text-gray-300 text-sm mt-0.5">{s.description}</div>
                  <div className="text-gray-400 text-xs mt-1 font-mono">{s.amountLabel}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Pseudo-calldata toggle ─────────────────────────────────────────── */}
      {sim && (
        <div className="mt-6">
          <button
            onClick={() => setShowCalldata((v) => !v)}
            className="text-sm text-sky-400 hover:text-sky-300 underline underline-offset-2 transition-colors"
          >
            {showCalldata ? "▾ Hide" : "▸ Show"} pseudo-calldata
          </button>
          {showCalldata && (
            <pre className="mt-3 bg-gray-900/80 border border-gray-700/60 rounded-xl p-4 text-xs text-gray-300 overflow-x-auto font-mono leading-relaxed">
              {pseudoCalldata}
            </pre>
          )}
        </div>
      )}

      {/* ── Disclaimer ────────────────────────────────────────────────────── */}
      <div className="mt-8 bg-amber-900/10 border border-amber-700/30 rounded-xl p-4 text-xs text-amber-300/80">
        ⚠️ <strong>Disclaimer:</strong> This is a simulation tool only. No on-chain transactions
        are submitted. Slippage, fees, and rates are estimates based on live data. Always verify
        parameters on-chain before executing. Flash loans carry smart contract and liquidation risk.
      </div>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function FLField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm text-gray-400 mb-1.5">{label}</label>
      {children}
    </div>
  );
}

function FLCard({
  label,
  value,
  color,
  wide,
}: {
  label: string;
  value: string;
  color: string;
  wide?: boolean;
}) {
  return (
    <div
      className={`bg-gray-800/50 rounded-lg p-4 border border-gray-700/50 ${wide ? "col-span-2" : ""}`}
    >
      <div className="text-gray-400 text-xs uppercase tracking-wide mb-1">{label}</div>
      <div className={`text-lg font-mono font-bold ${color}`}>{value}</div>
    </div>
  );
}
