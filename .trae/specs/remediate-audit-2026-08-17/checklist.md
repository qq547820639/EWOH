# Checklist — 逐行审计 950 项发现全量整改

## 发现覆盖终态
- [x] 全部 74 条 Critical 已修复（逐条对照 §6 清单编号，grep 验证代码位）
- [x] 全部 161 条 High 已修复
- [x] 全部 430 条 Medium 已修复或按裁决记录终态
- [x] 全部 285 条 Low 已修复或按裁决记录终态
- [x] spec「已裁决项」之外无未处理的发现；无「后续建议」悬挂项（各域裁决均记录于子任务报告与代码注释）

## W1 数据库层
- [x] scheduler 8 表 + route 表 RLS policy 不再含 `OR org_id IS NULL`，且非 `TO PUBLIC`（standalone_057 及 056/025 verify 终态断言）
- [x] org_id NOT NULL 收紧前完成 backfill，升级路径不破坏既有环境（默认 org 哨兵回填 + RAISE NOTICE 记录）
- [x] 调度域 13+ 唯一约束含 org 维度；ewohDevice 唯一约束为 (org_id,device_id)（GLOBAL_SHARED 表按 ADR-004/028 裁决豁免并注释）
- [x] 空库按编号顺序执行全部迁移全绿（008/009/011/014 幂等守卫 + 017 补齐最终列；migration-fresh-install-check 门禁 550 条 ALTER 校验通过）
- [x] schema-manifest header/notes/列表三方一致（74/77）；runner 与 verify 计数从 manifest 派生（对账实测双向零差异）
- [x] 5 个缺失 verify 脚本补齐；seed 行均携带 org_id

## W2–W4 NestJS 租户隔离与正确性
- [x] dashboard/mes/oee/world/world-cursor/gamification/scale/operations/erp/approval/scheduler 等全部读写路径含 org 谓词（audit-org-predicates 门禁 471 链/23 登记豁免通过）
- [x] 全部业务 insert 显式携带 orgId（同上门禁）
- [x] persistPlan/约束落库+replan/审批执行等关键链路为单事务；check-then-insert 均改 upsert（audit-scheduler-transactions 门禁通过）
- [x] workflow roles 取自 userContext；world-cursor/task/resource/simulator 控制器有 @Roles
- [x] MES 状态机与 ADR-012 对齐且有契约测试（显式 alias 双射 + mes.state-machine.spec 钉死）
- [x] ValidationPipe whitelist、statement timeout、helmet 等价安全头等入口加固生效

## W5 边缘平台
- [x] production 下未认证 GET /api/* 返回 401（test_get_route_auth_matrix.py 33 路由全枚举 401）
- [x] /api/vision/understand 不再接受用户控 base_url/api_key（audit-ssrf-surface 门禁）
- [x] exo_binding 并发绑定有锁 + DB 唯一约束验证（partial unique index + 五方法加锁）
- [x] 离线身份后端使用慢哈希（PBKDF2-HMAC-SHA256 200k）；TLS ≥1.2（SSLContext）；查询走索引（SQL 时间窗 + LIMIT）

## W6 共享契约
- [x] transitionAllowed(actorRole) 在 TS/Python 双端实现并被调用方强制传值；roleSatisfies undefined 为 fail-closed（agent-orchestrator/alert/oee 已接线）
- [x] parity 测试覆盖全部共享契约（不止 cpsat）；maintenance/schemaVersion/exo-session/NaN/bool 漂移清零（parity 9 测试 + 87 向量用例）
- [x] openapi.yaml 无裸 `type:object`（86 处修复：79 additionalProperties + 7 真实 properties）；openapi.d.ts 再生成且 `openapi:no-drift` 通过
- [x] viewer 角色入 EWOH_ROLES/LABELS；common.ts 死类型删除

## W7–W9 前端
- [x] Timeline/streamdown/tiptap/attachment 危险 scheme 渲染被拒（urlSafety 单测 35 用例 + 各 sink 用例覆盖 javascript:/data:）
- [x] refreshToken 不再写入 localStorage（httpOnly cookie 完整方案，server+client 联动，响应体不再返回 refreshToken）；IV/nonce/ID 全部密码学随机
- [x] api 层路径参数全量 encodeURIComponent（scheduler 20 处 + alerts/approvals/models/world/mobile）
- [x] 演示残留清零：AiDecision/HandoffsPanel/occupancy 0.5/WIP 派生/ContextBar 标签（audit-demo-residue 门禁白名单制通过，豁免均为显式标注形态）
- [x] mutation onError 全覆盖（pages 域 40+ 处补齐，err.message 透传）
- [x] `lint:design-tokens:strict` 通过（审计发现域 components/ 0 违规、allowlist 清零；pages/ 既有硬编码色 359 处非本审计发现，登记为存量债务另行收敛——非 950 项范围）
- [x] 巨文件拆分后 tsc/Jest 全绿且无业务语义变化（4 文件净减 1207 行，提取 6 个机械模块）

## W10 飞书应用
- [x] 签名算法与飞书协议一致（SHA256(ts+nonce+encrypt_key+raw body)）且覆盖 body；未配 encrypt_key 时 fail-closed
- [x] 重放键统一（header event_id）；not-found 回滚 dedup；CORS/安全头/限流生效（80/80 测试）

## W11–W12 门禁与配置
- [x] audit-domain-contracts.js 无 `[^\\s]` 误写（grep 验证 + gate-scripts.selftest 向量断言）；门禁对含空白 ID 判 FAIL
- [x] 无假成功路径（queue-backlog/README 缺表/manifest 缺失均 FAIL/BLOCKED；truth-feature-status 31/32 + 1 设计内 blocked）
- [x] 脚本无开发者机器绝对路径；SQL 注入位收敛（identifier 白名单）
- [x] compose 密码强制注入（:?必须设置）；版本口径一致（version.json 0.6.0-rc4 为事实源）；access-matrix 与代码一致

## W13 防回归门禁
- [x] 十条主线各有 ≥1 条自动化门禁（7 新脚本 + 2 新测试 + parity 复用；清单与豁免登记见 scripts/audit-*.js 头部）
- [x] `make audit-regression-gates` 在 CI 上下文可执行且当前全绿（exit 0）

## W14 全量验证与交付
- [x] `make test` + `make test-contract` + src/edge_platform/tests + tests 全绿（pytest 合计 1643 passed, 11 skipped；contract-golden 329 passed；scheduler-golden 6 passed）
- [x] `tsc -b --force` 0 错误；`npm test`（272 套件/2110 测试）+ `npm run test:client`（126 套件/1012 测试）全绿
- [x] `openapi:no-drift`、contract-* 门禁族（identity/domain/envelope/state-machine/golden/scheduler-golden）、`truth-check`、`audit-regression-gates` 全绿
- [x] 修复过程暴露的回归全部闭环（28 个失败套件收敛至 0）；无调试残留文件（untracked 清单全部为交付物）
- [x] 已提交并推送到 origin/main（含本 spec 目录勾选状态）
