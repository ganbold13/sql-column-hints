-- Demo file for the SQL Column Hints extension. All data here is made up.
-- Open it in the Extension Development Host (F5) to see the hints.

-- ---------------------------------------------------------------------------
-- A wide multi-row INSERT: every value gets its column name in front of it.
-- ---------------------------------------------------------------------------
INSERT INTO `wallet` (`id`, `user_id`, `wallet_rule_id`, `currency_id`, `active_date`, `expire_date`, `status`, `name`, `first_name`, `last_name`, `phone_number`, `register_number`, `source`, `wallet_number`, `created_at`, `updated_at`, `flag`) VALUES
(1, 1, 10, 1, NULL, NULL, 1, 'Demo', 'Alice', 'Example Ltd', '99000001', 'AA00000001', NULL, '1000000001', NOW(), NULL, 0),
(2, 1, 10, 1, NULL, NULL, 1, 'Demo', 'Bob', 'Example Ltd', '99000002', 'AA00000002', NULL, '1000000002', NOW(), NULL, 0),
(3, 2, 11, 1, NULL, NULL, 0, 'Demo', 'Жишээ хэрэглэгч', 'Тест ХХК', NULL, 'AA00000003', NULL, '1000000003', NOW(), NULL, 0);

-- ---------------------------------------------------------------------------
-- Tricky values: commas and parentheses inside strings and function calls are
-- counted as one value each, so the column mapping stays correct.
-- ---------------------------------------------------------------------------
INSERT INTO `log` (`id`, `note`, `payload`, `amount`, `created_at`) VALUES
  (1, 'contains, a comma and a )', CONCAT('a', ',', '(b)'), -2.50, NOW()),
  (2, 'it''s escaped', IF(1 > 0, 'yes', 'no'), 66667000.000000, NOW());

-- ---------------------------------------------------------------------------
-- This second row is missing two values -> warning in the Problems panel.
-- ---------------------------------------------------------------------------
INSERT INTO `wallet_rule` (`id`, `name`, `rate`, `active`) VALUES
  (10, 'standard', 0.05, 1),
  (11, 'promo');

-- No column list, so there is nothing to label.
INSERT INTO `wallet_flag` VALUES (1, 'demo');

-- INSERT ... SELECT is left alone too.
INSERT INTO `wallet_archive` (`id`, `user_id`) SELECT `id`, `user_id` FROM `wallet`;
