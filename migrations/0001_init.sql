CREATE TABLE IF NOT EXISTS cart_items (
  cart_key TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  shop_name TEXT NOT NULL DEFAULT '',
  shop_slug TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  variation TEXT NOT NULL DEFAULT '',
  product_url TEXT NOT NULL,
  image_url TEXT NOT NULL DEFAULT '',
  cart_order INTEGER NOT NULL DEFAULT 0,
  unit_price INTEGER NOT NULL,
  streaming_price INTEGER,
  effective_price INTEGER NOT NULL,
  original_price INTEGER,
  first_unit_price INTEGER NOT NULL,
  first_effective_price INTEGER NOT NULL,
  min_effective_price INTEGER NOT NULL,
  max_effective_price INTEGER NOT NULL,
  prev_effective_price INTEGER,
  target_price INTEGER,
  voucher_hint TEXT NOT NULL DEFAULT '',
  flash_sale_text TEXT NOT NULL DEFAULT '',
  cart_drop_badge TEXT NOT NULL DEFAULT '',
  is_inactive INTEGER NOT NULL DEFAULT 0,
  in_cart INTEGER NOT NULL DEFAULT 1,
  is_hidden INTEGER NOT NULL DEFAULT 0,
  alert_muted INTEGER NOT NULL DEFAULT 0,
  last_alerted_price INTEGER,
  last_alerted_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_checked_at TEXT NOT NULL,
  last_changed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cart_items_in_cart ON cart_items(in_cart, is_hidden, cart_order);

CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cart_key TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  unit_price INTEGER NOT NULL,
  streaming_price INTEGER,
  effective_price INTEGER NOT NULL,
  is_inactive INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_price_history_key_time ON price_history(cart_key, recorded_at);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  synced_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'chrome-extension',
  total_in_cart INTEGER NOT NULL,
  active_count INTEGER NOT NULL,
  inactive_count INTEGER NOT NULL,
  changed_count INTEGER NOT NULL,
  alerts_sent INTEGER NOT NULL DEFAULT 0,
  telegram_ok INTEGER,
  note TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_time ON sync_runs(synced_at DESC);
