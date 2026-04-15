# Yield Loop Dashboard

A real-time analytics dashboard for on-chain looping (leverage) strategies on yield-bearing stablecoins. Compares collateral yields against borrow costs across Morpho Blue, Aave V3, and Aave Horizon to identify optimal risk-adjusted leveraged yield opportunities on Ethereum.

**Live:** Deployed on Vercel

## Supported Assets

| Collateral | Protocol | Borrow Venues | Base Yield Source |
|------------|----------|---------------|-------------------|
| sUSDE | Ethena sUSDe | Aave V3, Morpho | DeFiLlama |
| sUSDS | Sky sUSDS | Morpho | DeFiLlama |
| syrupUSDC | Maple syrupUSDC | Morpho | DeFiLlama |
| SyrupUSDT | Maple SyrupUSDT | Aave V3, Morpho | DeFiLlama |
| sNUSD | Neutrl sNUSD | Morpho | Manual (Pendle implied) |
| VBILL | VanEck VBILL | Aave Horizon | Manual (T-bill rate) |
| wstETH | Lido wstETH | Aave V3 (E-Mode), Morpho | DeFiLlama (Lido staking) |

Borrow assets: USDC, USDT, PYUSD, RLUSD for stablecoin strategies; WETH for wstETH strategies.

---

## Tabs Overview

### Overview

Summary table showing all strategies ranked by net yield. Displays base yield, cheapest borrow rate, spread, liquidity, utilization, and net APY at 3x and 5x leverage. Data refreshes every 5 minutes from DeFiLlama and Morpho.

### Individual Asset Tabs (sUSDE, sUSDS, etc.)

Per-asset detail view with:
- Summary cards (base yield, best borrow, spread, leveraged yields)
- Borrow venue comparison table sorted by rate
- Historical charts: price, APY, and borrow rates by venue
- For sUSDS: oracle vs CoinGecko price overlay with deviation stats
- For wstETH: CAPO oracle ratio vs market-implied ratio overlay with deviation stats
- APR summary: 30-day average, 90-day average, 90-day annualized volatility

### Flash Loan Builder

Simulates single-transaction leveraged entry via flash loans. Models the full atomic execution: flash borrow, DEX swap, deposit, borrow against collateral, repay flash. Calculates effective leverage after accounting for flash loan fees and swap slippage.

Flash loan providers: Balancer (0 bps), Aave V3 (5 bps), Morpho Flash (0 bps). DEX aggregators: 1inch, Paraswap, Uniswap V3, CowSwap.

### Entry & Exit Cost Calculator

Quotes three venues side by side and picks the cheapest:

| Venue | Source | Notes |
|-------|--------|-------|
| Curve StableSwap | on-chain `get_dy` | per-market pool address (e.g. sUSDS/USDT, wstETH/ETH); slippage is derived by comparing against a tiny reference swap, so the exchange-rate spread is separated from price impact |
| Uniswap V3 | on-chain `QuoterV2.quoteExactInputSingle` | full concentrated-liquidity tick-walk simulation (replaces the old constant-product approximation) |
| Aggregator (0x / 1inch) | server-proxied price endpoint | realistic routing quote; enabled by setting `ZEROEX_API_KEY` or `ONEINCH_API_KEY` on the server. Falls back silently when unset |

Each loop is quoted individually. The aggregator quote is compared against a
1-token reference quote to isolate slippage + aggregator routing cost.

Gas is computed per venue: Morpho Blue (~230k supply+borrow), Aave V3 (~390k),
Aave V3 E-Mode (+30k), plus per-loop swap gas and any wrap/stake overhead.

---

## Calculator — Methodology

The calculator models net yield for a looping strategy at user-specified leverage, LTV, and starting capital.

### Core Formulas

**Leveraged position:**
```
Total Assets = Starting Capital x Leverage
Debt = Total Assets - Starting Capital
Collateral Units = Total Assets / Collateral Price
```

**Net APY:**
```
Net APY = (Base Yield x Leverage) - (Borrow APY x (Leverage - 1))
```

This is equivalent to:
```
Net APY = Base Yield + Spread x (Leverage - 1)
```
where `Spread = Base Yield - Borrow APY`.

**Loops required** to reach target leverage via recursive borrowing at a given LTV:
```
Loops = ln(1 - Leverage x (1 - LTV)) / ln(LTV) - 1
```

Maximum achievable leverage at a given LTV is `1 / (1 - LTV)`.

**Health factor:**
```
Health Factor = (Collateral Value x Liquidation LTV) / Debt Value
```

Liquidation occurs when health factor falls below 1.0.

**Liquidation price:**
```
Liquidation Price = Debt Value / (Collateral Units x Liquidation LTV)
```

### Slippage Simulator

Models cumulative slippage cost across multiple looping transactions:
```
Total Slippage = 1 - (1 - Slippage Per Swap) ^ Loops
Slippage Cost = Total Slippage x Total Assets
Net APY After Slippage = Net APY - (Slippage Cost / Starting Capital)
Break-even Days = Slippage Cost / Daily Net Yield
```

### Interest Rate Models

The calculator uses venue-specific IRM models to estimate how borrow rates change with additional debt.

#### Morpho Blue — Adaptive Curve IRM

Constants: `CURVE_STEEPNESS = 4`, `TARGET_UTILIZATION = 90%`

```
if utilization > 90%:
    err = (utilization - 0.9) / 0.1
    borrowApy = (3 x err + 1) x apyAtTarget

if utilization <= 90%:
    err = (utilization - 0.9) / 0.9
    borrowApy = (0.75 x err + 1) x apyAtTarget
```

The curve is steeper above 90% utilization (coefficient 3) and flatter below (coefficient 0.75), incentivizing utilization toward the 90% target. `apyAtTarget` is fetched from the Morpho GraphQL API per market.

#### Aave V3 — Two-Slope Kink Model

The model back-calculates `slope1` from the current observed borrow rate to ensure consistency:
```
slope1 = currentBorrowApy / (currentUtilization / optimalUtilization)
```

Below the optimal utilization kink:
```
borrowApy = slope1 x (utilization / optimalUtilization)
```

Above the kink:
```
excessUtilization = (utilization - optimal) / (1 - optimal)
borrowApy = slope1 + slope2 x excessUtilization
```

Optimal utilization: USDC/USDT 92%, PYUSD 90%, RLUSD 80%.

---

## Backtester — Methodology

The backtester simulates historical performance of a looping strategy using on-chain oracle-accurate pricing. It reconstructs the exact price that Morpho's liquidation engine would use, ensuring the simulation faithfully represents real market conditions.

### Oracle Architecture

The backtester replicates the **MorphoChainlinkOracleV2** (`0x0C426d174FC88B7A25d59945Ab2F7274Bf7B4C79`) pricing formula:

```
Oracle Price = (sUSDS Exchange Rate x DAI/USD) / USDT/USD
```

Each component is queried on-chain at historical block numbers:

| Component | Contract | Method | Decimals |
|-----------|----------|--------|----------|
| sUSDS Exchange Rate | `0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD` | `convertToAssets(1e18)` | 18 |
| DAI/USD (BASE_FEED_1) | `0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9` | `latestRoundData()` | 8 |
| USDT/USD (QUOTE_FEED_1) | `0x3E7d1eAB13ad0104d2750B8863b489D65364e32D` | `latestRoundData()` | 8 |

These addresses were read directly from the oracle contract's `BASE_FEED_1`, `QUOTE_FEED_1`, and `VAULT` storage slots.

### wstETH/ETH Oracle Architecture (CAPO)

For wstETH/ETH looping strategies, the oracle uses Aave's **Correlated Asset Price Oracle (CAPO)** mechanism rather than the Morpho oracle. CAPO caps the wstETH/stETH exchange ratio growth to prevent manipulation.

```
Oracle Price = min(Lido Ratio, CAPO Ceiling) x ETH/USD
```

Where the CAPO ceiling grows linearly from a snapshot:
```
CAPO Ceiling = Snapshot Ratio + Max Growth Per Second x (Current Time - Snapshot Time)
```

On-chain data sources at each historical block:

| Component | Contract | Method | Decimals |
|-----------|----------|--------|----------|
| wstETH/stETH Ratio | stETH `0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84` | `getPooledEthByShares(1e18)` | 18 |
| ETH/USD | Chainlink `0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419` | `latestRoundData()` | 8 |
| CAPO Snapshot Ratio | `0xe1D97bF61901B075E9626c8A2340a7De385861Ef` | `snapshotRatio()` | 18 |
| CAPO Snapshot Timestamp | `0xe1D97bF61901B075E9626c8A2340a7De385861Ef` | `snapshotTimestamp()` | — |
| CAPO Max Growth/s | `0xe1D97bF61901B075E9626c8A2340a7De385861Ef` | `maxYearlyRatioGrowthPercent()` | 18 |

The effective ratio is `min(lidoRatio, capoCeiling)`. In practice, the ceiling only binds during rapid staking ratio increases, acting as a safety cap.

**Deviation analysis for wstETH** compares ratios rather than USD prices to isolate oracle risk from ETH price volatility:
- **On-chain ratio:** CAPO-adjusted wstETH/ETH ratio
- **Market ratio:** CoinGecko wstETH/USD divided by Chainlink ETH/USD

This surfaces genuine oracle risk (e.g., CAPO ceiling binding during rapid ratio growth) without confounding it with normal ETH/USD price movements.

### wstETH Borrow Rate Sources

| Venue | Source | Data |
|-------|--------|------|
| Morpho wstETH/WETH | Morpho GraphQL API | `historicalState.borrowApy` with `interval: HOUR` |
| Aave V3 wstETH/ETH (E-Mode) | DeFiLlama | `/yields/chart/e880e828-ca59-4ec6-8d4f-27182a4dc23d` (Aave V3 WETH pool) |

The Aave V3 E-Mode for wstETH/ETH has a liquidation threshold of 93% and max LTV of 90%.

### Data Collection

All data is fetched client-side via an Alchemy archive node to avoid serverless timeout constraints.

**Adaptive interval** based on lookback period:
- 14 days or less: hourly
- 15-45 days: every 2 hours
- 46-90 days: every 4 hours
- Over 90 days: every 6 hours

**Block resolution:** Binary search for start/end blocks (within +/-500 of estimate), then linear interpolation for intermediate blocks at ~12 seconds per block.

**Parallel data sources:**
1. **On-chain oracle snapshots** — 3 RPC calls per block (exchange rate + 2 Chainlink feeds), batched 30 blocks at a time with 100ms delay
2. **CoinGecko sUSDS/USD** — hourly off-chain price for deviation analysis (proxied through API route to avoid CORS)
3. **Morpho borrow rates** — GraphQL historical query with `interval: HOUR`

Missing data points are forward-filled from the last known value.

### Simulation Engine

**Entry position setup:**
```
Total Assets = Starting Capital x Leverage
Initial Debt = Total Assets - Starting Capital
Collateral Units = Total Assets / Oracle Price at Entry
```

Collateral units remain fixed throughout (no rebalancing). The strategy assumes a single entry with no intermediate deposits or withdrawals.

**Each time step:**
```
Hours Elapsed = (Current Timestamp - Previous Timestamp) / 3600
Step Rate = Borrow APY x (Hours Elapsed / 8760)
Debt Value = Previous Debt x (1 + Step Rate)

Collateral Value = Collateral Units x Current Oracle Price
Health Factor = (Collateral Value x Liquidation LTV) / Debt Value
Equity = Collateral Value - Debt Value
```

Interest compounds at each step using actual timestamp deltas, not fixed intervals. This ensures correct accrual regardless of data granularity.

**Return calculation:**
```
Cumulative Return = (Equity / Starting Capital) - 1
Years Elapsed = (Current Timestamp - Entry Timestamp) / (8760 x 3600)
Annualized Return = (1 + Cumulative Return) ^ (1 / Years Elapsed) - 1
```

**Liquidation:** Triggered when health factor drops below 1.0. Simulation continues post-liquidation to show the full trajectory.

**Drawdown:** Peak-to-trough equity decline tracked continuously.

### Oracle vs CoinGecko Deviation Analysis

Compares the on-chain oracle price (used by Morpho for liquidations) against CoinGecko's off-chain market price. Reports:
- Maximum deviation over the period
- 30-day and 60-day average deviation
- Annualized tracking error
- Maximum drawdown in oracle price

This analysis surfaces oracle risk — if the oracle price diverges significantly from market price, it could trigger unexpected liquidations or create arbitrage opportunities.

### Margin for Error

Safety analysis based on current parameters:
- **Starting Health Factor:** Initial HF at entry price
- **Liquidation Price:** Oracle price where HF = 1.0
- **Worst-Case Health Factor:** HF if the maximum historical drawdown occurred from the entry price
- **Buffer to Liquidation:** Percentage the price can drop from entry before liquidation

### Capacity Analysis

Models how net APY degrades as strategy size increases, using the Morpho adaptive curve IRM with real market state (current supply, borrow, and `apyAtTarget` from the live Morpho market).

For logarithmically-spaced capital sizes from $10K to $100M:
```
Additional Debt = Capital x (Leverage - 1)
New Utilization = (Current Borrow + Additional Debt) / Current Supply
Estimated Borrow APY = Morpho IRM(New Utilization, apyAtTarget)
Net APY = Collateral APY x Leverage - Estimated Borrow APY x (Leverage - 1)
```

Key outputs:
- **Optimal size:** Where net APY is maximized
- **Break-even size:** Where net APY reaches zero
- **Max safe size:** Where utilization stays below 95%

### Parameter Optimization

Grid search over LTV (30% to LLTV) and leverage (1.1x to max) parameter space. Each combination runs a full backtest simulation. Results are displayed as a heatmap of annualized returns, with the optimal point (highest return with no liquidation and HF > 1.05) highlighted.

### Exit Signal Framework

Five signal types backtested against historical data:

| Signal | Trigger Condition | Rationale |
|--------|-------------------|-----------|
| Negative Carry | Borrow APY > Collateral APY | Strategy is losing money on each marginal dollar |
| Health Warning | Health Factor < 1.30 | Approaching liquidation zone |
| Rate Spike | Borrow APY > 2x rolling 24h average | Sudden rate increase, likely temporary but dangerous |
| Spread Compression | Net APY < 1% | Risk/reward no longer favorable |
| Depeg Alert | Oracle price drops > 0.5% in 24 hours | Collateral may be depegging |

For each signal: trigger count, timestamps, whether it would have exited before liquidation, and average cumulative return at trigger time.

---

## Data Sources

| Source | Data | Endpoint | Refresh |
|--------|------|----------|---------|
| DeFiLlama | Base yields, Aave borrow rates, TVL | `yields.llama.fi/pools`, `/lendBorrow`, `/chart/{id}` | 5 min |
| Morpho GraphQL | Market data, borrow APY, utilization, LLTV | `blue-api.morpho.org/graphql` | 5 min |
| CoinGecko | Token prices, historical prices | `api.coingecko.com/api/v3/` | 2 min |
| Chainlink (on-chain) | DAI/USD, USDT/USD, ETH/USD price feeds | Archive node RPC | On-demand |
| sUSDS Vault (on-chain) | Exchange rate (sUSDS to USDS) | Archive node RPC | On-demand |
| Lido stETH (on-chain) | wstETH/stETH exchange ratio | `getPooledEthByShares(1e18)` | On-demand |
| CAPO Adapter (on-chain) | wstETH ratio ceiling params | `snapshotRatio()`, `maxYearlyRatioGrowthPercent()` | On-demand |

---

## Tech Stack

- **Framework:** Next.js 16 with App Router
- **Styling:** Tailwind CSS
- **Charts:** Recharts
- **Ethereum:** viem (archive node RPC via Alchemy)
- **Deployment:** Vercel
- **Data fetching:** SWR for caching, client-side RPC for backtester

---

## Development

```bash
npm install
npm run dev
```

Requires `.env.local`:
```
ETH_RPC_URL=<alchemy-archive-node-url>
NEXT_PUBLIC_ETH_RPC_URL=<same-url-for-client-side-backtester>
```

The `NEXT_PUBLIC_` variant is needed because the backtester runs RPC calls directly from the browser to avoid Vercel serverless timeout limits.

---

## Disclaimer

This dashboard is for informational and educational purposes only. It does not constitute financial advice. Leveraged DeFi strategies carry significant risk including but not limited to liquidation, smart contract risk, oracle risk, and market risk. Past performance simulated by the backtester does not guarantee future results. Gas costs are not modeled. Always do your own research.
