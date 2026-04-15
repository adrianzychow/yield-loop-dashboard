"use client";

import { useState, useCallback, useEffect } from "react";
import { useSwapQuotes, type CostSummary } from "@/hooks/useSwapQuotes";
import { loopCount, type GasProfile } from "@/lib/gasEstimates";
import type { SwapConfig, SwapCostResult, VenueComparison } from "@/lib/swapQuotes";

interface EntryCostCalculatorProps {
  ltv: number;
  leverage: number;
  startingCapital: number;
  swapConfig: SwapConfig;
  gasProfile: GasProfile;
}

export default function EntryCostCalculator({
  ltv,
  leverage,
  startingCapital,
  swapConfig,
  gasProfile,
}: EntryCostCalculatorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [gasPriceGwei, setGasPriceGwei] = useState(15);
  const [ethUsdPrice, setEthUsdPrice] = useState(1800);
  const [ethPriceLoaded, setEthPriceLoaded] = useState(false);

  const { result, isLoading, error, fetchQuotes } = useSwapQuotes();

  // Fetch ETH price from CoinGecko proxy on mount
  useEffect(() => {
    if (ethPriceLoaded) return;
    const url =
      "/api/backtest?cgUrl=" +
      encodeURIComponent(
        "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd"
      );
    fetch(url)
      .then((r) => r.json())
      .then((data) => {
        if (data?.ethereum?.usd) {
          setEthUsdPrice(Math.round(data.ethereum.usd));
          setEthPriceLoaded(true);
        }
      })
      .catch(() => {});
  }, [ethPriceLoaded]);

  const handleCalculate = useCallback(() => {
    fetchQuotes({
      startingCapital,
      leverage,
      ltv,
      gasPriceGwei,
      ethUsdPrice,
      swapConfig,
      gasProfile,
    });
  }, [
    fetchQuotes,
    startingCapital,
    leverage,
    ltv,
    gasPriceGwei,
    ethUsdPrice,
    swapConfig,
    gasProfile,
  ]);

  const loops = loopCount(leverage, ltv);

  return (
    <div className="bg-gray-800/50 border border-gray-700 rounded-xl overflow-hidden">
      <button
        onClick={() => setIsOpen((v) => !v)}
        className="w-full flex items-center justify-between px-6 py-4 hover:bg-gray-800/80 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold text-gray-100">
            Entry &amp; Exit Cost Calculator
          </span>
          <span className="text-xs text-gray-500 bg-gray-700 rounded px-2 py-0.5">
            {loops} loops at {(ltv * 100).toFixed(0)}% LTV
          </span>
          <span className="text-xs text-gray-500 bg-gray-900 rounded px-2 py-0.5">
            {swapConfig.debtToken.symbol} ↔ {swapConfig.collateralToken.symbol}
          </span>
        </div>
        <span className="text-gray-400 text-sm">
          {isOpen ? "▾ Collapse" : "▸ Expand"}
        </span>
      </button>

      {isOpen && (
        <div className="px-6 pb-6 space-y-6">
          {/* Inputs */}
          <div className="flex items-end gap-4 flex-wrap">
            <InputField
              label="Starting Capital ($)"
              disabled
              value={startingCapital.toLocaleString()}
            />
            <InputField
              label="Target Leverage"
              disabled
              value={`${leverage.toFixed(1)}x`}
            />
            <InputField
              label="LTV (from market)"
              disabled
              value={`${(ltv * 100).toFixed(1)}%`}
            />
            <div>
              <label className="block text-xs text-gray-400 mb-1">
                Gas Price (gwei)
              </label>
              <input
                type="number"
                value={gasPriceGwei}
                onChange={(e) =>
                  setGasPriceGwei(Math.max(0.1, Number(e.target.value)))
                }
                className="bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm w-24"
                min={0.1}
                step={1}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">
                ETH/USD
                {ethPriceLoaded && (
                  <span className="text-emerald-400 ml-1">(live)</span>
                )}
              </label>
              <input
                type="number"
                value={ethUsdPrice}
                onChange={(e) =>
                  setEthUsdPrice(Math.max(1, Number(e.target.value)))
                }
                className="bg-gray-900 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm w-28"
                min={1}
                step={10}
              />
            </div>
            <button
              onClick={handleCalculate}
              disabled={isLoading}
              className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-600 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {isLoading ? "Fetching quotes..." : "Calculate Costs"}
            </button>
          </div>

          <div className="flex gap-6 text-sm text-gray-400">
            <span>
              Loops: <span className="text-white font-mono">{loops}</span>
            </span>
            <span>
              Total swap volume:{" "}
              <span className="text-white font-mono">
                $
                {(startingCapital * (leverage - 1)).toLocaleString(undefined, {
                  maximumFractionDigits: 0,
                })}
              </span>
            </span>
            <span>
              Lender:{" "}
              <span className="text-white font-mono">{gasProfile.label}</span>
            </span>
          </div>

          {error && (
            <div className="bg-red-900/20 border border-red-800 rounded-lg p-3 text-sm text-red-300">
              {error}
            </div>
          )}

          {result && !result.aggregatorAvailable && (
            <div className="bg-amber-900/20 border border-amber-800/70 rounded-lg p-3 text-xs text-amber-300">
              Aggregator quote unavailable
              {result.aggregatorError ? `: ${result.aggregatorError}` : ""} —
              showing only on-chain Curve + Uniswap V3 QuoterV2. Set{" "}
              <code className="text-amber-200">ZEROEX_API_KEY</code> or{" "}
              <code className="text-amber-200">ONEINCH_API_KEY</code> to enable
              aggregator pricing.
            </div>
          )}

          {result && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <CostColumn
                title="Entry Costs"
                subtitle={`Opening the leveraged position (${swapConfig.debtToken.symbol} → ${swapConfig.collateralToken.symbol})`}
                venues={result.entryVenues}
                totalSwapVol={result.totalSwapVol}
                gasManualUsd={result.entryGasManualUsd}
                gasFlashBalancerUsd={result.entryGasFlashBalancerUsd}
                gasFlashMorphoUsd={result.entryGasFlashMorphoUsd}
                gasFlashAaveUsd={result.entryGasFlashAaveUsd}
                totalManual={result.entryTotalManual}
                totalFlash={result.entryTotalFlash}
                flashSaving={result.flashSavingEntry}
                startingCapital={startingCapital}
                loops={result.loops}
                aggregatorSource={result.aggregatorSource}
              />
              <CostColumn
                title="Exit Costs"
                subtitle={`Unwinding the position (${swapConfig.collateralToken.symbol} → ${swapConfig.debtToken.symbol})`}
                venues={result.exitVenues}
                totalSwapVol={result.totalSwapVol}
                gasManualUsd={result.exitGasManualUsd}
                gasFlashBalancerUsd={result.exitGasFlashBalancerUsd}
                gasFlashMorphoUsd={result.exitGasFlashMorphoUsd}
                gasFlashAaveUsd={result.exitGasFlashAaveUsd}
                totalManual={result.exitTotalManual}
                totalFlash={result.exitTotalFlash}
                flashSaving={result.flashSavingExit}
                startingCapital={startingCapital}
                loops={result.loops}
                aggregatorSource={result.aggregatorSource}
              />
            </div>
          )}

          <div className="text-xs text-gray-500 border-t border-gray-700/50 pt-3 leading-relaxed">
            <div>
              <strong className="text-gray-400">Slippage sources:</strong>{" "}
              Curve uses on-chain <code>get_dy</code>. Uniswap V3 uses{" "}
              <code>QuoterV2.quoteExactInputSingle</code> (full tick-walk, exact
              for CLMM). Aggregator uses the 0x/1inch price endpoint and
              reflects routing across multiple pools.
            </div>
            <div className="mt-1">
              <strong className="text-gray-400">Gas:</strong> per-venue
              empirical averages (Morpho ≈ 230k supply+borrow, Aave V3 ≈ 390k,
              E-Mode + 30k). Wrap/unwrap and flash-loan router overhead are
              added when applicable.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────

function InputField({
  label,
  value,
  disabled,
}: {
  label: string;
  value: string;
  disabled?: boolean;
}) {
  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1">{label}</label>
      <div className={`bg-gray-900/50 border border-gray-700 rounded-lg px-3 py-2 text-gray-300 text-sm ${disabled ? "opacity-80" : ""}`}>
        {value}
      </div>
    </div>
  );
}

function CostColumn({
  title,
  subtitle,
  venues,
  totalSwapVol,
  gasManualUsd,
  gasFlashBalancerUsd,
  gasFlashMorphoUsd,
  gasFlashAaveUsd,
  totalManual,
  totalFlash,
  flashSaving,
  startingCapital,
  loops,
  aggregatorSource,
}: {
  title: string;
  subtitle: string;
  venues: VenueComparison;
  totalSwapVol: number;
  gasManualUsd: number;
  gasFlashBalancerUsd: number;
  gasFlashMorphoUsd: number;
  gasFlashAaveUsd: number;
  totalManual: number;
  totalFlash: number;
  flashSaving: number;
  startingCapital: number;
  loops: number;
  aggregatorSource: "0x" | "1inch" | null;
}) {
  const bpsOfPosition =
    startingCapital > 0 ? (totalFlash / startingCapital) * 10_000 : 0;

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-base font-semibold text-white">{title}</h4>
        <p className="text-xs text-gray-500">{subtitle}</p>
      </div>

      <div>
        <h5 className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">
          Swap Costs
        </h5>
        <SwapVenueTable
          venues={venues}
          totalSwapVol={totalSwapVol}
          aggregatorSource={aggregatorSource}
        />
      </div>

      <div>
        <h5 className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">
          Gas Costs
        </h5>
        <div className="bg-gray-900/50 rounded-lg border border-gray-700/50 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-500 text-xs border-b border-gray-700/50">
                <th className="px-3 py-2 text-left font-medium">Execution</th>
                <th className="px-3 py-2 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              <tr>
                <td className="px-3 py-2 text-gray-300">
                  Manual ({loops} loops)
                </td>
                <td className="px-3 py-2 text-right font-mono text-gray-200">
                  ${gasManualUsd.toFixed(2)}
                </td>
              </tr>
              <tr>
                <td className="px-3 py-2 text-gray-300">Flash (Balancer)</td>
                <td className="px-3 py-2 text-right font-mono text-gray-200">
                  ${gasFlashBalancerUsd.toFixed(2)}
                </td>
              </tr>
              <tr>
                <td className="px-3 py-2 text-gray-300">Flash (Morpho)</td>
                <td className="px-3 py-2 text-right font-mono text-gray-200">
                  ${gasFlashMorphoUsd.toFixed(2)}
                </td>
              </tr>
              <tr>
                <td className="px-3 py-2 text-gray-300">Flash (Aave V3)</td>
                <td className="px-3 py-2 text-right font-mono text-gray-200">
                  ${gasFlashAaveUsd.toFixed(2)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-gray-900/50 rounded-lg border border-gray-700/50 p-4 space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-gray-400">Manual total</span>
          <span className="font-mono text-gray-200">
            ${totalManual.toFixed(2)}
          </span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-400">Flash loan total</span>
          <span className="font-mono text-white font-semibold">
            ${totalFlash.toFixed(2)}
          </span>
        </div>
        <div className="border-t border-gray-700/50 pt-2 flex justify-between text-sm">
          <span className="text-gray-400">Flash saving</span>
          <span
            className={`font-mono font-semibold ${
              flashSaving > 0 ? "text-emerald-400" : "text-gray-400"
            }`}
          >
            {flashSaving > 0 ? `$${flashSaving.toFixed(2)}` : "$0.00"}
          </span>
        </div>
        <div className="flex justify-between text-xs text-gray-500">
          <span>Cost as % of position</span>
          <span className="font-mono">{bpsOfPosition.toFixed(1)} bps</span>
        </div>
      </div>
    </div>
  );
}

function SwapVenueTable({
  venues,
  totalSwapVol,
  aggregatorSource,
}: {
  venues: VenueComparison;
  totalSwapVol: number;
  aggregatorSource: "0x" | "1inch" | null;
}) {
  const rows: { key: "curve" | "uniswap" | "aggregator"; data: SwapCostResult }[] = [
    { key: "curve", data: venues.curve },
    { key: "uniswap", data: venues.uniswap },
    { key: "aggregator", data: venues.aggregator },
  ];

  return (
    <div className="bg-gray-900/50 rounded-lg border border-gray-700/50 overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-gray-500 text-xs border-b border-gray-700/50">
            <th className="px-3 py-2 text-left font-medium">Venue</th>
            <th className="px-3 py-2 text-right font-medium">Fee</th>
            <th className="px-3 py-2 text-right font-medium">Slippage</th>
            <th className="px-3 py-2 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800/50">
          {rows.map(({ key, data }) => {
            const isRecommended = venues.recommended === key;
            const totalBps =
              data.available && totalSwapVol > 0
                ? (data.totalCost / totalSwapVol) * 10_000
                : 0;
            const label =
              key === "aggregator"
                ? aggregatorSource
                  ? `Aggregator (${aggregatorSource})`
                  : data.venueLabel
                : data.venueLabel;
            return (
              <tr
                key={key}
                className={`${isRecommended ? "bg-emerald-900/10" : ""} ${
                  !data.available ? "opacity-50" : ""
                }`}
              >
                <td className="px-3 py-2 text-gray-300">
                  {label}
                  {isRecommended && data.available && (
                    <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-emerald-800 text-emerald-300">
                      Best
                    </span>
                  )}
                  {!data.available && data.warning && (
                    <div className="text-xs text-gray-500 mt-0.5">
                      {data.warning}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-right font-mono text-gray-200">
                  {data.available ? `$${data.totalFeeCost.toFixed(2)}` : "—"}
                </td>
                <td className="px-3 py-2 text-right font-mono text-gray-200">
                  {data.available ? `$${data.totalSlippageCost.toFixed(2)}` : "—"}
                </td>
                <td className="px-3 py-2 text-right font-mono text-white font-semibold">
                  {data.available ? (
                    <>
                      ${data.totalCost.toFixed(2)}
                      <span className="text-gray-500 text-xs ml-1">
                        ({totalBps.toFixed(1)} bps)
                      </span>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
