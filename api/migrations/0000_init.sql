CREATE TABLE IF NOT EXISTS datapoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  indicator TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  data JSON NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(symbol, indicator, timestamp)
);

-- Add indexes for common queries
CREATE INDEX IF NOT EXISTS idx_datapoints_symbol_indicator ON datapoints(symbol, indicator);

CREATE INDEX IF NOT EXISTS idx_datapoints_timestamp ON datapoints(timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_datapoints_lookup ON datapoints(symbol, indicator, timestamp DESC);