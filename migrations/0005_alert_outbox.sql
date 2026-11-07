CREATE TABLE alert_outbox (
  cart_key TEXT PRIMARY KEY REFERENCES cart_items(cart_key),
  observed_at INTEGER NOT NULL,
  unit_price INTEGER NOT NULL,
  effective_price INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL
);
CREATE INDEX idx_alert_outbox_due ON alert_outbox(next_attempt_at);
