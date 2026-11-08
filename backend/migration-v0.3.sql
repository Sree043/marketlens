-- MarketLens v0.3 migration. Safe to run more than once. Does NOT touch existing tables or trades.
CREATE TABLE IF NOT EXISTS universe (
  symbol TEXT PRIMARY KEY,
  name TEXT,
  series TEXT NOT NULL DEFAULT 'EQ',
  isin TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  last_price REAL,
  last_price_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS scan_jobs (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'all',
  status TEXT NOT NULL DEFAULT 'running',
  total INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  ok_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  cursor_symbol TEXT,
  cursor_index INTEGER NOT NULL DEFAULT 0,
  options TEXT,
  symbols_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS scan_results (
  job_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  data TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (job_id, symbol)
);
CREATE INDEX IF NOT EXISTS idx_universe_active ON universe(active, series, symbol);
CREATE INDEX IF NOT EXISTS idx_jobs_owner ON scan_jobs(owner, created_at);
CREATE INDEX IF NOT EXISTS idx_results_status ON scan_results(job_id, status);
