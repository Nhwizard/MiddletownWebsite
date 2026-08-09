CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('sermons', 'bulletins', 'bible-passages')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  passage TEXT NOT NULL DEFAULT '',
  resource_date TEXT,
  original_name TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL DEFAULT 'application/pdf',
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 78643200),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_resources_category_date
ON resources (category, resource_date DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS login_attempts (
  ip_hash TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  window_started INTEGER NOT NULL
);
