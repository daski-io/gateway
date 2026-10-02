-- 055's permanent insert trigger is now installed. Remove only the temporary
-- pre-055 barrier; the permanent guard keeps both current and prior runtimes
-- safe. Applied 055 bytes and checksum remain unchanged.
DROP TRIGGER standard_order_seed_sale_guard_install ON standard_orders;
DROP FUNCTION standard_seed_order_sale_guard_install();
