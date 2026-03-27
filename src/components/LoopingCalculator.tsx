"use client";

import { useState, useMemo, useEffect } from "react";
import { ASSETS } from "@/lib/constants";
import { MorphoMarket, DefiLlamaBorrowPool, StrategyRow, DebtOption } from "@/lib/types";
import { estimateBorrowApyAfterDebt } from "@/lib/irm";
import { formatPct, formatUsd } from "@/lib/utils";
import { fetchTokenPrices, getTokenPrice } from "@/lib/api/coingecko";

// ─── Slippage Simulator helpers ───────────────────────────────────────────────
interface SlippageResult {
  slippageBps: number;
  totalSlippagePct: number;
  slippageCostUsd: number;
  netApyAfterSlippage: number;
  breakEvenDays: number;
}

function computeSlippage(
  loops: number,
  slippageBps: number,
  startingValue: number,
  totalAssets: number,
  netApy: number
): SlippageResult {
  const slippagePerSwap = slippageBps / 10_000;
  // Each loop: swap stablecoin → collateral, once per loop
  const totalSlippagePct = (1 - Math.pow(1 - slippagePerSwap, loops)) * 100;
  const slippageCostUsd = (totalSlippagePct / 100) * totalAssets;
  const netApyAfterSlippage =
    startingValue > 0
      ? netApy - (slippageCostUsd / startingValue) * 100
      : netApy;
  // Days to recoup slippage cost from net yield
  const dailyYield = (netApy / 100) * startingValue / 365;
  const breakEvenDays =
    dailyYield > 0 ? slippageCostUsd / dailyYield : Infinity;

  return {
    slippageBps,
    totalSlippagePct,
    slippageCostUsd,
    netApyAfterSlippage,
    breakEvenDays,
  };
}

interface LoopingCalculatorProps {
  strategies: StrategyRow[];
  morphoMarkets: MorphoMarket[];
  borrowPools: DefiLlamaBorrowPool[];
}

export default function LoopingCalculator({
  strategies,
  morphoMarkets,
  borrowPools,
}: LoopingCalculatorProps) {
  // Inputs
  const [collateral, setCollateral] = useState(ASSETS[0].name);
  const [selectedDebtIdx, setSelectedDebtIdx] = useState(0);
  const [startingValue, setStartingValue] = useState(100000);
  const [initialLtv, setInitialLtv] = useState(75);
  const [targetLeverage, setTargetLeverage] = useState(3);

  // Slippage simulator
  const [slippageBps, setSlippageBps] = useState(5); // default 5 bps = 0.05%

  // Prices
  const [prices, setPrices] = useState<Record<string, number>>({});
  useEffect(() => {
    fetchTokenPrices().then(setPrices).catch(() => {});
  }, []);

  const strategy = strategies.find((s) => s.asset.name === collateral);
  const baseYield = strategy?.baseYield ?? 0;

  // Build debt options from the strategy's borrow markets + raw data
  const debtOptions: DebtOption[] = useMemo(() => {
    if (!strategy) return [];
    const options: DebtOption[] = [];

    for (const bm of strategy.allBorrowMarkets) {
      if (bm.venue === "Morpho") {
        // Find the matching Morpho market for IRM params
        const asset = ASSETS.find((a) => a.name === collateral);
        const collateralAddr = asset?.borrowVenues
          .find((v) => v.venue === "Morpho")
          ?.morphoCollateralAddress?.toLowerCase();

        const mm = morphoMarkets.find(
          (m) =>
            m.collateralAsset.address.toLowerCase() === collateralAddr &&
            m.loanAsset.symbol === bm.borrowAsset &&
            (m.state.liquidityAssetsUsd ?? 0) >= 1000
        );

        if (!mm) continue;

        const lltv = parseInt(mm.lltv) / 1e18;

        options.push({
          label: `${bm.borrowAsset} (Morpho)`,
          venue: "Morpho",
          borrowAsset: bm.borrowAsset,
          currentBorrowApy: bm.borrowRate / 100, // convert from pct to decimal
          liquidationLtv: lltv,
          totalBorrowedUsd: mm.state.borrowAssetsUsd ?? 0,
          totalSuppliedUsd: mm.state.supplyAssetsUsd ?? 0,
          morphoApyAtTarget: mm.state.apyAtTarget ?? undefined,
        });
      } else {
        // Aave - find matching DeFiLlama borrow pool
        const assetConfig = ASSETS.find((a) => a.name === collateral);
        const venueConfig = assetConfig?.borrowVenues.find(
          (v) => v.venue === bm.venue
        );
        const poolId = venueConfig?.poolIds?.[bm.borrowAsset];
        const pool = poolId
          ? borrowPools.find((p) => p.pool === poolId)
          : undefined;

        // Aave LTV varies by collateral; use a reasonable default
        // In practice this should be fetched from Aave's reserve config
        const lltv = bm.venue === "Aave Horizon" ? 0.77 : 0.865;

        options.push({
          label: `${bm.borrowAsset} (${bm.venue})`,
          venue: bm.venue,
          borrowAsset: bm.borrowAsset,
          currentBorrowApy: bm.borrowRate / 100,
          liquidationLtv: lltv,
          totalBorrowedUsd: pool?.totalBorrowUsd ?? 0,
          totalSuppliedUsd: pool?.totalSupplyUsd ?? 0,
        });
      }
    }

    return options;
  }, [strategy, collateral, morphoMarkets, borrowPools]);

  // Reset debt selection when collateral changes
  useEffect(() => {
    setSelectedDebtIdx(0);
  }, [collateral]);

  const debt = debtOptions[selectedDebtIdx] ?? null;

  const collateralPrice = getTokenPrice(prices, collateral);
  const debtTokenPrice = debt ? getTokenPrice(prices, debt.borrowAsset) : 1.0;

  // Outputs
  const outputs = useMemo(() => {
    if (!debt) return null;

    const assets = startingValue * targetLeverage;
    const debtAmount = assets - startingValue;

    // Collateral APY (percentage)
    const collateralApy = baseYield;

    // Estimated borrow APY after adding debt
    const estimatedBorrowApyDecimal = estimateBorrowApyAfterDebt({
      venue: debt.venue,
      borrowAsset: debt.borrowAsset,
      currentBorrowedUsd: debt.totalBorrowedUsd,
      currentSuppliedUsd: debt.totalSuppliedUsd,
      additionalDebtUsd: debtAmount,
      currentBorrowApy: debt.currentBorrowApy,
      morphoApyAtTarget: debt.morphoApyAtTarget,
    });
    const estimatedBorrowApy = estimatedBorrowApyDecimal * 100; // to pct

    // APY price impact
    const currentBorrowApy = debt.currentBorrowApy * 100;
    const apyPriceImpact = estimatedBorrowApy - currentBorrowApy;

    // Loops required: LN((1 - targetLeverage) * (1 - initialLTV)) / LN(initialLTV) - 1
    // When target leverage exceeds max (1/(1-LTV)), result is Infinity
    const ltvDecimal = initialLtv / 100;
    let loopsRequired = Infinity;
    const maxLeverage = 1 / (1 - ltvDecimal);
    if (ltvDecimal > 0 && ltvDecimal < 1 && targetLeverage > 1) {
      if (targetLeverage < maxLeverage) {
        // Both formulations are equivalent for achievable leverage:
        // ln((1-T)*(1-L)) / ln(L) - 1  ≡  ln(1-T*(1-L)) / ln(L) - 1
        const inner = 1 - targetLeverage * (1 - ltvDecimal);
        const numerator = Math.log(inner);
        const denominator = Math.log(ltvDecimal);
        if (denominator !== 0 && isFinite(numerator)) {
          loopsRequired = Math.max(0, numerator / denominator - 1);
        }
      }
      // else: leverage >= max → stays Infinity
    } else if (targetLeverage <= 1) {
      loopsRequired = 0;
    }

    // Liquidation price = debt / (assets / collateralPrice * liquidationLtv)
    const collateralUnits = assets / collateralPrice;
    const liquidationPrice =
      collateralUnits > 0 && debt.liquidationLtv > 0
        ? (debtAmount * debtTokenPrice) /
          (collateralUnits * debt.liquidationLtv)
        : 0;

    // Net APY: collateral yield on assets - borrow cost on debt
    // = (collateralApy * assets - estimatedBorrowApy * debt) / startingValue
    const netApy =
      startingValue > 0
        ? (collateralApy * assets - estimatedBorrowApy * debtAmount) /
          startingValue
        : 0;

    return {
      assets,
      debt: debtAmount,
      collateralApy,
      estimatedBorrowApy,
      apyPriceImpact,
      loopsRequired,
      liquidationPrice,
      netApy,
    };
  }, [
    debt,
    startingValue,
    targetLeverage,
    initialLtv,
    baseYield,
    collateralPrice,
    debtTokenPrice,
  ]);

  // Slippage simulation result
  const slippageResult = useMemo<SlippageResult | null>(() => {
    if (!outputs || !isFinite(outputs.loopsRequired)) return null;
    const loops = Math.ceil(outputs.loopsRequired);
    if (loops <= 0) return null;
    return computeSlippage(
      loops,
      slippageBps,
      startingValue,
      outputs.assets,
      outputs.netApy
    );
  }, [outputs, slippageBps, startingValue]);

  return (
    <div>
      <h2 className="text-xl font-bold text-white mb-6">Looping Calculator</h2>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Inputs */}
        <div className="space-y-5">
          <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">
            Inputs
          </h3>

          {/* Collateral */}
          <Field label="Collateral">
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
          </Field>

          {/* Collateral price */}
          <Field label="Collateral Token Price">
            <div className="input-display">${collateralPrice.toFixed(4)}</div>
          </Field>

          {/* Debt market */}
          <Field label="Debt Market">
            {debtOptions.length > 0 ? (
              <select
                value={selectedDebtIdx}
                onChange={(e) => setSelectedDebtIdx(Number(e.target.value))}
                className="input-field"
              >
                {debtOptions.map((d, i) => (
                  <option key={`${d.label}-${i}`} value={i}>
                    {d.label} — {(d.currentBorrowApy * 100).toFixed(2)}% APY
                  </option>
                ))}
              </select>
            ) : (
              <div className="input-display text-gray-500">
                No borrow markets available
              </div>
            )}
          </Field>

          {/* Debt token price */}
          <Field label="Debt Token Price">
            <div className="input-display">${debtTokenPrice.toFixed(4)}</div>
          </Field>

          {/* Starting value */}
          <Field label="Starting Value ($)">
            <input
              type="number"
              value={startingValue}
              onChange={(e) =>
                setStartingValue(Math.max(0, Number(e.target.value)))
              }
              className="input-field"
              min={0}
              step={1000}
            />
          </Field>

          {/* Initial LTV */}
          <Field label={`Initial LTV (${initialLtv}%)`}>
            <input
              type="range"
              min={0}
              max={debt ? Math.floor(debt.liquidationLtv * 100) - 1 : 95}
              value={initialLtv}
              onChange={(e) => setInitialLtv(Number(e.target.value))}
              className="w-full accent-emerald-500"
            />
            <div className="flex justify-between text-xs text-gray-500 mt-1">
              <span>0%</span>
              <span>
                Liq. LTV: {debt ? (debt.liquidationLtv * 100).toFixed(1) : "—"}%
              </span>
            </div>
          </Field>

          {/* Target leverage */}
          <Field label={`Target Leverage (${targetLeverage.toFixed(1)}x)`}>
            <input
              type="range"
              min={10}
              max={100}
              value={targetLeverage * 10}
              onChange={(e) => setTargetLeverage(Number(e.target.value) / 10)}
              className="w-full accent-emerald-500"
            />
            <div className="flex justify-between text-xs text-gray-500 mt-1">
              <span>1.0x</span>
              <span className={targetLeverage > 1 / (1 - initialLtv / 100) ? "text-red-400" : ""}>
                Max at {initialLtv}% LTV: {(1 / (1 - initialLtv / 100)).toFixed(1)}x
              </span>
              <span>10.0x</span>
            </div>
          </Field>
        </div>

        {/* Outputs */}
        <div className="space-y-5">
          <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">
            Outputs
          </h3>

          {outputs ? (
            <>
              <div className="grid grid-cols-2 gap-4">
                <OutputCard
                  label="Total Assets"
                  value={formatUsd(outputs.assets)}
                  accent="gray"
                />
                <OutputCard
                  label="Total Debt"
                  value={formatUsd(outputs.debt)}
                  accent="amber"
                />
                <OutputCard
                  label="Collateral APY"
                  value={formatPct(outputs.collateralApy)}
                  accent="emerald"
                />
                <OutputCard
                  label="Est. Borrow APY"
                  value={formatPct(outputs.estimatedBorrowApy)}
                  accent="amber"
                />
                <OutputCard
                  label="APY Price Impact"
                  value={`${outputs.apyPriceImpact >= 0 ? "+" : ""}${outputs.apyPriceImpact.toFixed(2)}%`}
                  accent={outputs.apyPriceImpact > 0.1 ? "red" : "gray"}
                />
                <OutputCard
                  label="Loops Required"
                  value={
                    isFinite(outputs.loopsRequired)
                      ? Math.ceil(outputs.loopsRequired).toString()
                      : "∞ (exceeds max leverage)"
                  }
                  accent={isFinite(outputs.loopsRequired) ? "gray" : "red"}
                />
                <OutputCard
                  label="Liquidation Price"
                  value={`$${outputs.liquidationPrice.toFixed(4)}`}
                  accent="red"
                />
                <OutputCard
                  label="Net APY"
                  value={formatPct(outputs.netApy)}
                  accent={outputs.netApy > 0 ? "emerald" : "red"}
                  large
                />
              </div>

              {/* Utilization impact visualization */}
              <UtilizationBar
                current={
                  debt
                    ? debt.totalBorrowedUsd /
                      (debt.totalSuppliedUsd || 1)
                    : 0
                }
                after={
                  debt
                    ? (debt.totalBorrowedUsd + outputs.debt) /
                      (debt.totalSuppliedUsd || 1)
                    : 0
                }
              />
            </>
          ) : (
            <div className="text-gray-500 py-12 text-center">
              Select a debt market to see outputs
            </div>
          )}
        </div>
      </div>

      {/* ── Slippage / Transaction Simulator ─────────────────────────────── */}
      <div className="mt-10 bg-gray-800/40 rounded-xl border border-purple-700/40 p-6">
        <div className="flex items-center gap-2 mb-4">
          <span className="text-purple-400 text-lg">⚙️</span>
          <h3 className="text-base font-semibold text-purple-300 uppercase tracking-wide">
            Transaction Slippage Simulator
          </h3>
        </div>
        <p className="text-gray-400 text-sm mb-5">
          Each loop requires a stablecoin → collateral swap on a DEX. This
          simulator estimates how much you lose to slippage across all loops and
          how long until the position breaks even.
        </p>

        {/* Slippage input */}
        <div className="mb-5">
          <label className="block text-sm text-gray-400 mb-1.5">
            Slippage per Swap — <span className="text-purple-300 font-mono">{slippageBps} bps ({(slippageBps / 100).toFixed(2)}%)</span>
          </label>
          <input
            type="range"
            min={1}
            max={100}
            value={slippageBps}
            onChange={(e) => setSlippageBps(Number(e.target.value))}
            className="w-full accent-purple-500"
          />
          <div className="flex justify-between text-xs text-gray-500 mt-1">
            <span>1 bps (0.01%) — tight DEX/aggregator</span>
            <span>100 bps (1%) — wide spread</span>
          </div>
        </div>

        {slippageResult ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <SlippageCard
              label="Total Slippage"
              value={`${slippageResult.totalSlippagePct.toFixed(3)}%`}
              sub={`across ${outputs ? Math.ceil(outputs.loopsRequired) : 0} loops`}
              color="text-amber-300"
            />
            <SlippageCard
              label="Slippage Cost"
              value={formatUsd(slippageResult.slippageCostUsd)}
              sub="one-time entry cost"
              color="text-red-400"
            />
            <SlippageCard
              label="Net APY (after slippage)"
              value={formatPct(slippageResult.netApyAfterSlippage)}
              sub="annualised on starting capital"
              color={slippageResult.netApyAfterSlippage > 0 ? "text-emerald-400" : "text-red-400"}
            />
            <SlippageCard
              label="Break-even"
              value={
                isFinite(slippageResult.breakEvenDays)
                  ? `${slippageResult.breakEvenDays.toFixed(1)} days`
                  : "Never"
              }
              sub="days to recoup slippage cost"
              color={
                !isFinite(slippageResult.breakEvenDays) || slippageResult.breakEvenDays > 180
                  ? "text-red-400"
                  : slippageResult.breakEvenDays > 30
                  ? "text-amber-300"
                  : "text-emerald-400"
              }
            />
          </div>
        ) : (
          <div className="text-gray-500 text-sm text-center py-4">
            {!outputs
              ? "Select a debt market to run the simulator"
              : "Leverage exceeds max — reduce target leverage to simulate slippage"}
          </div>
        )}

        {/* Visual slippage bar */}
        {slippageResult && outputs && (
          <div className="mt-5">
            <div className="text-xs text-gray-500 mb-1">
              Slippage drag on Net APY (before vs. after)
            </div>
            <div className="relative h-5 bg-gray-700 rounded-full overflow-hidden">
              {/* Gross net APY bar */}
              <div
                className="absolute inset-y-0 left-0 bg-emerald-600/60 rounded-full transition-all"
                style={{
                  width: `${Math.min(Math.max((outputs.netApy / 30) * 100, 0), 100)}%`,
                }}
              />
              {/* After-slippage bar */}
              <div
                className="absolute inset-y-0 left-0 bg-purple-500/60 rounded-full transition-all"
                style={{
                  width: `${Math.min(Math.max((slippageResult.netApyAfterSlippage / 30) * 100, 0), 100)}%`,
                }}
              />
            </div>
            <div className="flex justify-between text-xs text-gray-500 mt-1">
              <span className="text-emerald-400">Before slippage: {formatPct(outputs.netApy)}</span>
              <span className="text-purple-400">After slippage: {formatPct(slippageResult.netApyAfterSlippage)}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm text-gray-400 mb-1.5">{label}</label>
      {children}
    </div>
  );
}

function OutputCard({
  label,
  value,
  accent,
  large,
}: {
  label: string;
  value: string;
  accent: string;
  large?: boolean;
}) {
  const colorMap: Record<string, string> = {
    emerald: "text-emerald-400",
    red: "text-red-400",
    amber: "text-amber-400",
    gray: "text-gray-200",
  };
  return (
    <div
      className={`bg-gray-800/50 rounded-lg p-4 border border-gray-700/50 ${
        large ? "col-span-2" : ""
      }`}
    >
      <div className="text-gray-400 text-xs uppercase tracking-wide mb-1">
        {label}
      </div>
      <div
        className={`${large ? "text-2xl" : "text-lg"} font-mono font-bold ${
          colorMap[accent] ?? "text-gray-200"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function SlippageCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub: string;
  color: string;
}) {
  return (
    <div className="bg-gray-900/60 rounded-lg p-4 border border-purple-700/30">
      <div className="text-gray-400 text-xs uppercase tracking-wide mb-1">{label}</div>
      <div className={`text-lg font-mono font-bold ${color}`}>{value}</div>
      <div className="text-gray-500 text-xs mt-0.5">{sub}</div>
    </div>
  );
}

function UtilizationBar({
  current,
  after,
}: {
  current: number;
  after: number;
}) {
  const currentPct = Math.min(current * 100, 100);
  const afterPct = Math.min(after * 100, 100);

  return (
    <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700/50">
      <div className="text-gray-400 text-xs uppercase tracking-wide mb-3">
        Market Utilization Impact
      </div>
      <div className="relative h-6 bg-gray-700 rounded-full overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 bg-emerald-600/60 rounded-full transition-all"
          style={{ width: `${currentPct}%` }}
        />
        <div
          className="absolute inset-y-0 left-0 bg-amber-500/40 rounded-full transition-all"
          style={{ width: `${afterPct}%` }}
        />
      </div>
      <div className="flex justify-between text-xs text-gray-500 mt-2">
        <span>Current: {currentPct.toFixed(1)}%</span>
        <span>After: {afterPct.toFixed(1)}%</span>
        <span className={afterPct > 95 ? "text-red-400" : ""}>
          Change: +{(afterPct - currentPct).toFixed(2)}%
        </span>
      </div>
    </div>
  );
}
