SELECT set_config('search_path', 'public, pg_temp', false);
DROP FUNCTION IF EXISTS public.ewoh_find_active_user(text);
DROP FUNCTION IF EXISTS public.ewoh_find_org(uuid);
DROP FUNCTION IF EXISTS public.ewoh_find_org_children(uuid);
DROP TABLE IF EXISTS public.ewoh_user;
