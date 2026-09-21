-- standalone_105：隔离历史不合规 L3 Agent Manifest（ADR-016 收紧）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- L3 的契约语义是低风险、受限自治。历史校验允许 high/critical L3 或把
-- dispatch_task/create_work_order 等高风险写命令放进 L3 白名单。这些存量清单
-- 可能绕过人工审批，因此不删除、不改写证据：只把 status 置为 suspended，
-- 使 executeCommand fail-closed，待管理员重新以低风险契约注册新版本。
-- Re-entrant：UPDATE 条件幂等；重复执行不会扩大影响。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

UPDATE __EWOH_SCHEMA__.ewoh_agent_manifest AS manifest
   SET status = 'suspended',
       _updated_at = CURRENT_TIMESTAMP
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

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_agent_manifest IS
  'Agent Manifest 注册表（ADR-016）。standalone_105 后，历史不合规 L3（非 low 风险、不安全命令/作用域）必须保持 suspended，直到管理员按新契约重新注册。';

SELECT 1 AS standalone_105_verified;
