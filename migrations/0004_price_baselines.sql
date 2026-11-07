ALTER TABLE cart_items ADD COLUMN first_unit_price INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cart_items ADD COLUMN min_unit_price INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cart_items ADD COLUMN min_streaming_price INTEGER;
ALTER TABLE cart_items ADD COLUMN last_low_alert_price INTEGER;
ALTER TABLE cart_items ADD COLUMN last_live_alert_price INTEGER;
ALTER TABLE cart_items ADD COLUMN last_live_alert_at TEXT;

UPDATE cart_items SET
  first_unit_price = COALESCE((SELECT unit_price FROM price_history WHERE cart_key = cart_items.cart_key ORDER BY id LIMIT 1), unit_price),
  min_unit_price = MIN(unit_price, COALESCE((SELECT MIN(unit_price) FROM price_history WHERE cart_key = cart_items.cart_key), unit_price)),
  min_streaming_price = (SELECT MIN(price) FROM (
    SELECT streaming_price AS price FROM price_history WHERE cart_key = cart_items.cart_key AND streaming_price > 0 AND streaming_price < unit_price
    UNION ALL
    SELECT cart_items.streaming_price WHERE cart_items.streaming_price > 0 AND cart_items.streaming_price < cart_items.unit_price
  ));

UPDATE cart_items SET
  last_low_alert_price = CASE WHEN last_alerted_price = min_unit_price THEN last_alerted_price END,
  last_live_alert_price = CASE WHEN last_alerted_price = streaming_price THEN last_alerted_price END;
