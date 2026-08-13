# Checklist

> 状态：全部实施并验证通过。以下为验收清单，全部勾选。

## 事实源一致性收敛
- [x] `feature-status.yaml` 的 `decisionCockpit` 字段与真实代码一致（implemented/tested/deployable 为 true，evidence 指向真实文件）
- [x] README「能力状态清单」decisionCockpit 整行与 feature-status 同步
- [x] `feature-status.yaml` 中已不存在的 `output/bench-*.json` 失效证据已移除或更新为真实文件
- [x] `schema-manifest.yaml` 的 `managed_count` 与 `state.json` 受管表口径一致（57），`reconcile` 的 dbConsistent 通过
- [x] `truth-feature-status.js` 无 decisionCockpit WARN（31/31 PASS）

## 真正未完成功能闭合
- [x] `DecisionCockpit.tsx` 的 `feedback` 不再为静默 null（改为显式「暂无调度反馈数据」空态）
- [x] `CrossFactorySchedulerStub` / `CpSatOptimizer` / SiteReadiness / GitSync 有显式 fail-closed 边界与「待接入」标注，未伪造实现

## UX 深化
- [x] 核心页面状态色字面量收敛到语义 Token（RoleWorkbench/CommandMap 已替换；Devices 无状态色 hsl 字面量）
- [x] 设备详情呈现统一时间线（复用 Timeline + timelineModel），无数据时给出明确空态
- [x] 首启引导 + 角色化 Quick Start 入口已接线（复用 OnboardingQuickStart + Scale）
- [x] 孤儿页面（Overview/Events/Workers/CenterPlaceholder/ExamplePage）已删除，无残留引用
- [x] `Alerts.tsx` 离线横幅文案与真实行为一致

## 代码质量债
- [x] ingest 幂等查询失败不再 fail-open（改为 fail-closed + 日志）
- [x] work-orchestration 死代码（`applyGitSyncDurable` 无效三元）已清理
- [x] `audit/logger.py` 不再经 `stubs` 导入生产 Storage
- [x] 飞书 `api.js` 不把 `e.message` 直返客户端

## 验证
- [x] 前端 `type:check:client` 通过
- [x] 后端 `type:check:server` 通过
- [x] Python 边缘平台 `pytest tests/` 通过（161 passed, 10 skipped）
- [x] `truth-feature-status.js`（31/31）/ `reconcile-authoritative-artifacts.js`（6/6）/ `openapi:no-drift` 通过
- [x] 后端 ingest 单测 5 passed；前端相关 37 套件 303 测试通过
- [x] README 与 CHANGELOG 已更新
