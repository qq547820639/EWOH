-- standalone_073 verify：提案人列 + 生成人回避约束「存在且真的生效」。
-- 断言不只查字典，还做写入探测：构造一条 proposed_by = approved_by 的 approved
-- 行，必须被 CHECK 拒绝（同 071 口径：约束存在 + 约束真的挡住违规写入）。
-- 探测行无论约束是否生效都被显式清除（owner 连接不受 RLS 限制，FORCE 未开启）。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $$
DECLARE
  probe_rejected boolean := false;
BEGIN
  -- 前置守卫：迁移未应用时给出可读失败原因，而不是让下面的探测 INSERT
  -- 以 42703 undefined_column 的形式抛出难读的错误。
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ewoh_learning_proposal'
      AND column_name = 'proposed_by'
  ) THEN
    RAISE EXCEPTION 'standalone_073: proposed_by 列缺失（迁移未应用）';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '__EWOH_SCHEMA__.ewoh_learning_proposal'::regclass
      AND conname = 'chk_ewoh_learning_proposal_generator_avoidance'
  ) THEN
    RAISE EXCEPTION 'standalone_073: chk_ewoh_learning_proposal_generator_avoidance 约束缺失（迁移未应用）';
  END IF;

  BEGIN
    INSERT INTO __EWOH_SCHEMA__.ewoh_learning_proposal (
      org_id, proposal_id, kind, status, rule_id, parameter,
      baseline_value, candidate_value, shadow_eval_json,
      approved_by, approved_at, proposed_by, record_json
    ) VALUES (
      '__probe_073__', '__probe_073_self_approval__', 'rule_threshold', 'approved',
      'rule:worker-overload', 'workloadThreshold', 0.8, 0.75, '{}'::jsonb,
      'probe-approver', now(), 'probe-approver', '{}'::jsonb
    );
  EXCEPTION WHEN check_violation THEN
    probe_rejected := true;
  END;

  DELETE FROM __EWOH_SCHEMA__.ewoh_learning_proposal WHERE org_id = '__probe_073__';

  IF NOT probe_rejected THEN
    RAISE EXCEPTION 'standalone_073: generator-avoidance CHECK 未拒绝自批写入（约束未生效）';
  END IF;

  -- 反向对照：提议人与审批人不同（或提议人为 NULL 的存量行）必须可写，
  -- 否则约束过严会把合法审批路径一并锁死。
  BEGIN
    INSERT INTO __EWOH_SCHEMA__.ewoh_learning_proposal (
      org_id, proposal_id, kind, status, rule_id, parameter,
      baseline_value, candidate_value, shadow_eval_json,
      approved_by, approved_at, proposed_by, record_json
    ) VALUES (
      '__probe_073__', '__probe_073_cross_approval__', 'rule_threshold', 'approved',
      'rule:worker-overload', 'workloadThreshold', 0.8, 0.75, '{}'::jsonb,
      'probe-approver', now(), 'probe-proposer', '{}'::jsonb
    );
  EXCEPTION WHEN others THEN
    DELETE FROM __EWOH_SCHEMA__.ewoh_learning_proposal WHERE org_id = '__probe_073__';
    RAISE EXCEPTION 'standalone_073: 合法跨人审批写入被误拒（约束过严）: %', SQLERRM;
  END;

  DELETE FROM __EWOH_SCHEMA__.ewoh_learning_proposal WHERE org_id = '__probe_073__';
END $$;

SELECT CASE WHEN
  -- 列存在、类型/长度/可空性自证（NULL = 存量未回填行）
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ewoh_learning_proposal'
      AND column_name = 'proposed_by'
      AND data_type = 'character varying'
      AND character_maximum_length = 128
      AND is_nullable = 'YES') = 1
  -- 约束存在、已校验，且定义里确实同时约束提议人与审批人
  AND EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '__EWOH_SCHEMA__.ewoh_learning_proposal'::regclass
      AND conname = 'chk_ewoh_learning_proposal_generator_avoidance'
      AND convalidated
      AND pg_get_constraintdef(oid) LIKE '%proposed_by%'
      AND pg_get_constraintdef(oid) LIKE '%approved_by%'
  )
  -- 存量数据不违反约束（迁移在存量库上也可安全应用）
  AND (SELECT count(*) FROM __EWOH_SCHEMA__.ewoh_learning_proposal
        WHERE status = 'approved'
          AND proposed_by IS NOT NULL
          AND approved_by = proposed_by) = 0
  -- 探测行已清除（verify 无副作用）
  AND (SELECT count(*) FROM __EWOH_SCHEMA__.ewoh_learning_proposal
        WHERE org_id = '__probe_073__') = 0
  THEN 1 ELSE 0 END AS standalone_073_verified;
