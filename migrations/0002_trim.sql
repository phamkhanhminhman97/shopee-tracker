DROP INDEX IF EXISTS idx_cart_items_in_cart;

UPDATE cart_items SET in_cart = 0 WHERE is_inactive = 1;

ALTER TABLE cart_items DROP COLUMN shop_slug;
ALTER TABLE cart_items DROP COLUMN original_price;
ALTER TABLE cart_items DROP COLUMN first_unit_price;
ALTER TABLE cart_items DROP COLUMN max_effective_price;
ALTER TABLE cart_items DROP COLUMN prev_effective_price;
ALTER TABLE cart_items DROP COLUMN is_inactive;
ALTER TABLE cart_items DROP COLUMN is_hidden;
ALTER TABLE cart_items DROP COLUMN last_alerted_at;
ALTER TABLE cart_items DROP COLUMN last_checked_at;
ALTER TABLE cart_items DROP COLUMN last_changed_at;

ALTER TABLE price_history DROP COLUMN effective_price;
ALTER TABLE price_history DROP COLUMN is_inactive;

ALTER TABLE sync_runs DROP COLUMN active_count;
ALTER TABLE sync_runs DROP COLUMN inactive_count;

CREATE INDEX IF NOT EXISTS idx_cart_items_in_cart ON cart_items(in_cart, cart_order);
