-- standalone_105_agent_l3_policy_containment 验证。
-- Schema: __EWOH_SCHEMA__ (standalone → public)

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  active_invalid_l3 integer := 0;
BEGIN
  SELECT count(*) INTO active_invalid_l3
    FROM __EWOH_SCHEMA__.ewoh_agent_manifest AS manifest
   WHERE manifest.autonomous_level = 'L3'
     AND manifest.status <> 'suspended'
     AND (
       manifest.risk_level <> 'low'
       OR EXISTS (
         SELECT 1
           FROM jsonb_array_elements_text(manifest.write_scope -> 'commands') AS command(value)
          WHERE command.value NOT IN
            ('propose_plan', 'record_evidence', 'request_approval', 'run_simulation')
       )
       OR EXISTS (
         SELECT 1
           FROM jsonb_array_elements_text(manifest.write_scope -> 'tokens') AS token(value)
          WHERE token.value <> 'simulationData'
       )
     );
  IF active_invalid_l3 <> 0 THEN
    RAISE EXCEPTION 'standalone_105 verify failed: % active nonconforming L3 manifests', active_invalid_l3;
  END IF;
  RAISE NOTICE '105 verify OK: no active nonconforming L3 manifests';
END $$;

SELECT 1 AS standalone_105_verified;
