-- EWOH standalone runtime role rollback
-- DESTRUCTIVE: fails if ewoh_api still owns objects or has active sessions.
DROP ROLE IF EXISTS ewoh_api;
