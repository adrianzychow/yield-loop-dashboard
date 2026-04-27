-- Yield Loop Dashboard — Database Schema
-- Run once against your Neon Postgres database.
-- Vercel Storage → Neon console → SQL Editor, paste and execute.

-- ── Hourly on-chain oracle snapshots ──────────────────────────────
CREATE TABLE IF NOT EXISTS oracle_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  asset         TEXT         NOT NULL,   -- 'sUSDS', 'wstETH'
  ts            BIGINT       NOT NULL,   -- Unix seconds (hourly bucket)
  block_number  BIGINT       NOT NULL,
  exchange_rate DOUBLE PRECISION NOT NULL, -- sUSDS/USDS rate, or wstETH/ETH ratio
  base_price    DOUBLE PRECISION NOT NULL, -- DAI/USD for sUSDS; ETH/USD for wstETH
  quote_price   DOUBLE PRECISION NOT NULL, -- USDT/USD for sUSDS; 1.0 for wstETH
  oracle_price  DOUBLE PRECISION NOT NULL, -- computed: (rate * base) / quote
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE (asset, ts)
);

CREATE INDEX IF NOT EXISTS idx_oracle_asset_ts ON oracle_snapshots (asset, ts);

-- ── Hourly borrow APY per market ───────────────────────────────────
CREATE TABLE IF NOT EXISTS borrow_rates (
  id          BIGSERIAL PRIMARY KEY,
  market_key  TEXT         NOT NULL,  -- Morpho uniqueKey or 'aave-wsteth-eth'
  source      TEXT         NOT NULL,  -- 'morpho' | 'defillama'
  ts          BIGINT       NOT NULL,
  borrow_apy  DOUBLE PRECISION NOT NULL, -- decimal (0.03 = 3%)
  created_at  TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE (market_key, ts)
);

CREATE INDEX IF NOT EXISTS idx_borrow_market_ts ON borrow_rates (market_key, ts);

-- ── Hourly off-chain prices from DeFiLlama ─────────────────────────
CREATE TABLE IF NOT EXISTS defillama_prices (
  id      BIGSERIAL PRIMARY KEY,
  coin_id TEXT         NOT NULL,  -- 'coingecko:susds', 'coingecko:wrapped-steth'
  ts      BIGINT       NOT NULL,
  price   DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (coin_id, ts)
);

CREATE INDEX IF NOT EXISTS idx_llama_coin_ts ON defillama_prices (coin_id, ts);

-- ── Ingestion cursor — tracks last processed timestamp per stream ──
CREATE TABLE IF NOT EXISTS ingest_cursors (
  key        TEXT        PRIMARY KEY,  -- e.g. 'oracle:sUSDS', 'borrow:0xabc...', 'price:coingecko:susds'
  last_ts    BIGINT      NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
