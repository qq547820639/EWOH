-- standalone_097 回滚：移除 payload 指纹表（表为全新 additive；唯一约束/RLS 策略随表级联）。
-- 注意：回滚等于把"同 key 不同 payload → 409"防线交还给进程内 InMemoryPayloadStore
-- （缺陷 D 缺陷态：重启/多实例后静默放行改过 body 的离线重放），仅用于迁移链验证，
-- 生产禁用。回滚前如仍需保留审计证据，先导出
-- ewoh_idempotency_payload_fingerprint (org_id/scope/idempotency_key/fingerprint)。

DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_idempotency_payload_fingerprint;
