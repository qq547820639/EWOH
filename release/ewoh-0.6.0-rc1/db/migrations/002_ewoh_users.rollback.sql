SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);
DROP FUNCTION IF EXISTS __EWOH_SCHEMA__.ewoh_find_active_user(text);
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_user;
