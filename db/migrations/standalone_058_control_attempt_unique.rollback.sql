-- Rollback standalone_058_control_attempt_unique (NEST-425)
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_control_command_attempt;
