-- modules/wallets/migrations/0001_initial.sql
-- The atomic-entity table. Every other module foreign-keys here.
-- One row per wallet address. The provider column says HOW the agent
-- obtains the signer for that address (HD-derived from a mnemonic vs
-- imported raw key vs Privy embedded vs future provider).

CREATE TABLE wallets (
  address          TEXT PRIMARY KEY,            -- 0x-lowercased
  network          TEXT NOT NULL,               -- 'testnet' | 'mainnet'
  alias            TEXT,                        -- human label, optional
  provider_type    TEXT NOT NULL,               -- 'hd' | 'imported' | 'privy'
  provider_data    TEXT NOT NULL,               -- JSON, provider-specific
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  metadata_json    TEXT
);

CREATE INDEX idx_wallets_network_active
  ON wallets(network, active);

CREATE UNIQUE INDEX idx_wallets_alias_per_network
  ON wallets(network, alias)
  WHERE alias IS NOT NULL;

-- Roles a wallet can play (sponsor / resolver / voter). Default state:
-- a registered wallet has no role rows; roles are explicitly enabled.
-- This keeps "what can this wallet do" data-driven, not code-driven.
CREATE TABLE wallet_roles (
  address           TEXT NOT NULL,
  role              TEXT NOT NULL,              -- 'sponsor' | 'resolver' | 'voter'
  enabled           INTEGER NOT NULL DEFAULT 1,
  daily_budget_usd  REAL,
  PRIMARY KEY (address, role),
  FOREIGN KEY (address) REFERENCES wallets(address) ON DELETE CASCADE
);

-- Topic interests with weight. The orchestrator's action selector reads
-- this to decide whether a wallet should engage with a given question.
CREATE TABLE wallet_topics (
  address          TEXT NOT NULL,
  topic_id         TEXT NOT NULL,
  weight           REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (address, topic_id),
  FOREIGN KEY (address) REFERENCES wallets(address) ON DELETE CASCADE
);

-- Per-wallet KV overrides for any setting (preferred model, custom budget,
-- experimental flags). Schema-less to keep the wallets module from
-- knowing about settings keys other modules care about.
CREATE TABLE wallet_settings (
  address          TEXT NOT NULL,
  key              TEXT NOT NULL,
  value_json       TEXT,
  PRIMARY KEY (address, key),
  FOREIGN KEY (address) REFERENCES wallets(address) ON DELETE CASCADE
);
