# EWOH Training Plan

Status: ready v1.1 (training material complete; on-site signoff pending)
Owner: AG-52

## Audiences

- Global admins: org/space management, system config, model release.
- Dispatchers: task orchestration, resource preorder, AI suggestion/plan,
  control request.
- Workshop leads: task approval, alert handling, exception recovery.
- Safety admins: sensitive health access, alert close/reopen, approval bypass.
- Device ops: device search, config, binding, model assets.
- Operators: personal task view and risk feedback.

## Materials

- Deployment runbook: `docs/delivery/deployment-runbook.md`.
- Release checklist: `docs/delivery/release-checklist.md`.
- Acceptance evidence: `docs/delivery/acceptance-evidence.md`.
- Ops runbook: `docs/operations/README.md`.
- API contract: `openapi/ewoh.yaml`.
- Existing product/architecture docs under `docs/` and `delivery/`.

## Drills

- DDL apply/verify/rollback in a temporary PostgreSQL.
- Alert acknowledge/process/close/reopen drill.
- Task dispatch/execute/exception drill.
- AI suggestion/plan manual trigger drill.
- Control request retry/revoke drill.
- Cross-org access denial drill.
- Audit chain continuity check drill.
- PostgreSQL logical backup/restore drill
  (`scripts/standalone-ops-check.sh`).
- Full release drill (`scripts/release-drill.sh`).

## Session Model

| Session | Audience | Duration | Core exercises | Success check |
|---------|----------|----------|----------------|---------------|
| S1 平台总览 | 全体角色 | 60 min | 登录、导航、指挥中心、指挥地图、来源标识 | 每位学员独立登录并定位 1 个实体和 1 个事件 |
| S2 管理与安全 | 全局/安全管理员 | 90 min | 组织与人员、系统配置、审计、跨组织隔离、角色越权 | 跨组织访问被拒且审计链可查 |
| S3 生产运营 | 调度员/班组长 | 120 min | 任务状态机、审批、告警处置、控制请求、调度方案确认 | 完整走通 1 条任务/告警/方案闭环 |
| S4 运维与恢复 | 运维/管理员 | 120 min | 健康检查、逻辑备份恢复、发布演练、应急停止 | 独立完成一次恢复演练并保留证据 |

## Hands-on Exercises

### 认证与 RBAC

1. 使用演示账号登录，确认当前角色与可见导航。
2. 用低权限账号访问 `/api/system/config` 和 `/api/audit`，确认 403。
3. 用全局管理员账号创建一条组织配置并确认审计写入。

### 任务与审批

1. 创建草稿任务并依次执行 `submit -> approve -> dispatch -> start -> complete`。
2. 尝试非法状态迁移，确认返回状态冲突且原状态不变。
3. 创建两步骤审批，分别批准和否决，确认审计前后值。

### 告警与风险

1. 打开事件中心，对一条 open 事件执行 `acknowledge -> processing -> closed`。
2. 关闭后重新打开，确认状态机允许且审计链连续。
3. 验证平台没有任何急停/限扭/关节实时控制写入接口。

### 调度与人在回路

1. 手动触发 AI 建议/方案生成，确认不会自动下发。
2. 对比至少三个调度方案的分项指标并确认一个方案。
3. 对未确认方案尝试下发，确认被拒绝。

### 真机接入与来源隔离

1. 使用 `edge_to_spark.py --source-type simulated --org-id <org>` 推送帧。
2. 在数据库中确认 `source_type` 与 `record_id` 正确。
3. 重复推送同一 `raw_ref`，确认幂等跳过。

### 运维与恢复

1. 执行 `scripts/standalone-ops-check.sh` 完成逻辑备份恢复。
2. 执行 `scripts/release-drill.sh` 完成发布演练。
3. 模拟平台异常并执行应急停止流程，确认平台仅记录、不下发控制。

## Verification

- 每名学员完成对应 Session 的练习清单，由培训讲师复核。
- 练习结果保留时间、账号角色、输入、实际结果、截图/日志与通过状态。
- 涉及生产环境的行为必须在隔离环境演练，不得影响现场作业。
- 培训完成并签署后，才可将 `G11 业务验收` 推进到现场验收。
