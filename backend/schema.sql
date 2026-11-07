PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS owners (
  owner TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS watchlists (
  owner TEXT NOT NULL,
  symbol TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner, symbol),
  FOREIGN KEY (owner) REFERENCES owners(owner) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS paper_accounts (
  owner TEXT PRIMARY KEY,
  starting_cash REAL NOT NULL DEFAULT 5000,
  cash_balance REAL NOT NULL DEFAULT 5000,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner) REFERENCES owners(owner) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS paper_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  quantity REAL NOT NULL CHECK (quantity > 0),
  price REAL NOT NULL CHECK (price >= 0),
  executed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner) REFERENCES owners(owner) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS scan_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  symbol TEXT NOT NULL,
  price REAL,
  signal TEXT NOT NULL,
  rsi REAL,
  sma20 REAL,
  sma50 REAL,
  scanned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner) REFERENCES owners(owner) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_trades_owner_time ON paper_trades(owner, executed_at);
CREATE INDEX IF NOT EXISTS idx_scans_owner_time ON scan_runs(owner, scanned_at);
