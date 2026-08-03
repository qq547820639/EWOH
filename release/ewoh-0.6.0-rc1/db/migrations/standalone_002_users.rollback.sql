SELECT set_config('search_path', 'public, pg_temp', false);
DROP FUNCTION IF EXISTS public.ewoh_find_active_user(text);
DROP TABLE IF EXISTS public.ewoh_user;
