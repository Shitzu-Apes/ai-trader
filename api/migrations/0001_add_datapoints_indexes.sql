-- Migration to add indexes for optimizing datapoints queries
-- Index for timestamp lookups with symbol and indicator
CREATE INDEX IF NOT EXISTS idx_datapoints_symbol_indicator_timestamp ON datapoints(symbol, indicator, timestamp DESC);

-- Index for timestamp joins
CREATE INDEX IF NOT EXISTS idx_datapoints_timestamp ON datapoints(timestamp);

-- Index for final ordering
CREATE INDEX IF NOT EXISTS idx_datapoints_timestamp_indicator ON datapoints(timestamp ASC, indicator);