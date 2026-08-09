-- EWOH Command Map 智能调度驾驶舱 — outbox sequence verification (B1 修复)
-- Returns a single row with:
--   outbox_sequence_exists — 1 if ewoh_outbox_sequence_seq exists
--   outbox_sequence_default — 1 if ewoh_outbox.sequence DEFAULT uses the sequence
-- A result of (1,1) means the migration applied cleanly.
SELECT
  (SELECT count(*)::bigint
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'S'
      AND n.nspname = '__EWOH_SCHEMA__'
      AND c.relname = 'ewoh_outbox_sequence_seq'
  ) AS outbox_sequence_exists,
  (SELECT count(*)::bigint
     FROM pg_attrdef ad
     JOIN pg_class c ON c.oid = ad.adrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = '__EWOH_SCHEMA__'
      AND c.relname = 'ewoh_outbox'
      AND pg_get_expr(ad.adbin, ad.adrelid) LIKE '%ewoh_outbox_sequence_seq%'
  ) AS outbox_sequence_default;
