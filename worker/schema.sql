CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  subscription_json TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  place TEXT NOT NULL,
  timezone TEXT NOT NULL,
  threshold_c REAL NOT NULL,
  modes_json TEXT NOT NULL,
  last_cold_spell_key TEXT,
  last_summary_date TEXT,
  sent_periods_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS subscriptions_updated_at_idx ON subscriptions(updated_at);CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  subscription_json TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  place TEXT NOT NULL,
  timezone TEXT NOT NULL,
  threshold_c REAL NOT NULL,
  modes_json TEXT NOT NULL,
  last_cold_spell_key TEXT,
  last_summary_date TEXT,
  sent_periods_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS subscriptions_updated_at_idx ON subscriptions(updated_at);