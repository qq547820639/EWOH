# EWOH 安全边界代码审计

审计日期：2026-07-31
范围：`src/edge_platform/server.py`、`scheduler/orchestrator.py`、`governance/consent.py`、`edge/bus.py`、前端实时推送机制
目的：验证「平台下发实时关节或安全控制指令 = 0」「未经授权自动调度 = 0」「未授权视频或生理数据采集 = 0」在代码层成立，作为验收安全项的可验证证据（对应 spec 第十三节安全与隐私指标）。

## 检查清单

| # | 检查项 | 期望 | 代码证据 | 结论 |
| --- | --- | --- | --- | --- |
| S1 | 平台无急停/限扭/关节实时控制写入接口 | server 不提供任何写设备安全闭环参数的路由 | `server.py` 仅 `do_GET`（状态/设备/人员/遥测/推理/事件/任务）与 `do_POST`（`/api/event/status`、`/api/tasks/recommend`、`/api/tasks/confirm`、`/api/query`、`/api/scenario/evaluate`、`/api/reset`）；无任何 `emergency`/`estop`/`limit_torque`/`joint` 控制类路由；文件头注释明确「不提供任何写入急停、限扭、关节实时控制等安全闭环参数的接口」 | PASS |
| S2 | 调度无自动执行旁路 | `execute` 仅在 `CONFIRMED` 后标记 `EXECUTED` | `scheduler/orchestrator.py` L222-230：`if req.status != CONFIRMED: 返回拒绝记录，状态不变`；模块注释「无任何自动执行旁路」 | PASS |
| S3 | 人工确认必填理由 | 确认动作需 `actor_id` + `reason` | `orchestrator.py` L184 `confirm(request_id, plan_id, actor_id, reason)` | PASS |
| S4 | 员工可撤回授权 / 查询谁访问 | 提供撤回、列表、访问审计 | `governance/consent.py`：`revoke` 触发 `RevocationJob`；`is_allowed`/`list_for_person` 供员工知情；每次 `grant/revoke/check` 入 `access_log` | PASS |
| S5 | 来源隔离不可绕过 | 所有实体/事件携带 `source_type` | `edge/bus.py` 四流（telemetry/state/events/assets）均带 `source_type`；`/api/status` 暴露 `listeners {9001:real,9002:controlled_test,9003:simulated}` 与 `source_labels` | PASS |
| S6 | 零第三方运行时依赖（护栏） | `pyproject.toml` `dependencies == []` | `pyproject.toml` L15 `dependencies = []`；CI `test.yml` 新增断言步骤守护 | PASS |
| S7 | 大模型仅解释不控制 | 本地助手仅可答白名单、拒绝越权 | `services.py` Task 18：8 类可答问题引用真实证据，7 类拒绝策略；不生成传感器/调度数据 | PASS |
| S8 | 未授权视频/生理采集防护 | 采集需显式授权，撤回即停 | `consent.py` `ConsentPurpose`（VIDEO/SKELETON/TELEMETRY…）显式授权；`is_allowed` 逐用途逐字段判定 | PASS |

## 全仓危险模式扫描结果

对 `src/edge_platform` 全量扫描 `emergency|estop|limit_torque|joint|do_POST|write_device|control_command|set_torque`：
- `joint` / `joint_angles` 仅作为**遥测数据字段**出现（读取/展示），无任何写控制；
- `EQUIPMENT_EMERGENCY` 仅为**场景仿真方案类型**（受影响人员重新分配到健康设备/工位），属人员调度，不触碰设备安全控制；
- 无任何 `write_device` / `control_command` / `set_torque` 类接口。

## 结论

安全边界在代码层成立：平台对设备安全闭环参数零写入、调度零自动执行、来源隔离与员工数据权利均落实。可直接固化为验收安全项（spec 第十三节）的可验证证据。建议阶段 0 结束前将此审计纳入每次发布的回归检查。
