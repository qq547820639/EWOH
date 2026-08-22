# EWOH 告警积压清理与规则优化执行报告

> 执行时间：2026-08-23｜执行方：告警与运维专员
> 数据来源：ECS 生产库直查（`ewoh_event` 表，owner 视角绕过 RLS，统计为真实全量）
> 结论：**模拟测试告警积压已清零且不复发；7 条非 simulated 告警保留待人工复核**

---

## 一、执行前真实基线（直查数据库，非 API 截断值）

| 指标 | 数值 | 说明 |
|------|------|------|
| `ewoh_event` 总表 | **105,269** 行 | API `/api/alerts` 默认仅查近 24h、上限 500，故早前「499 open」是时间窗截断值 |
| status 分布 | expired 104,504 / **open 756** / active 7 / closed 2 | — |
| source_type 分布 | simulated 105,255（绝对主体）/ inference 5 / seed 3 / system 2 / simulation 2 / person 1 / device 1 | — |
| **OPEN 且按 source_type 分布（清理闸门）** | **simulated*→见下* | 见下 |

> ⚠️ **与任务书前提的关键校准**：任务书称「全部 499 open 均 simulated」。真实库核查发现 **OPEN 中有 7 条非 simulated**（inference 5 + simulation 2）。按「仅清理 simulated」原则，这 7 条**必须保留、不触碰**。

**OPEN 事件 source_type 明细（执行前）**：
| source_type | open 数 | 处理 |
|-------------|---------|------|
| simulated | 752（首次核查）→ 实际 786（含清理间隙新生成） | **已关闭** |
| inference | 5 | 保留（非 simulated） |
| simulation | 2 | 保留（非 simulated） |

---

## 二、根因分析（为何会反复堆积）

- `SimulatorService` 以默认 `EWOH_SIMULATOR_MAIN_TICK_MS=30_000`（30s）持续 tick，生成 `source_type='simulated'` 的遥测/事件/告警（DeviceLowBattery、WorkerHighLoad、DeviceOffline、WorkerPostureRisk、safety 等）。
- 运行容器 `EWOH_SIMULATOR_ENABLED=1`（持久化于 ECS `/opt/ewoh/.env` 第 18 行）→ **生产环境模拟器持续运行**，每 30s 产生新 open 告警。
- `RetentionService` 本应每小时间隔把「open 且 simulated 且 >2h」置为 `expired`（代码 `retention.service.ts:120-148`），但仅能压住 2h 内存量，**无法阻止再生** → 稳态下始终有约 2h 量的 open simulated 告警。
- 早期 104,504 条 `expired` 即历史模拟事件被 retention 过期的证据。

---

## 三、处理操作（先备份后改，全程可逆）

### 3.1 备份（审计可追溯）
```sql
CREATE TABLE ewoh_event_sim_open_bk_20260823 AS
SELECT * FROM ewoh_event WHERE status='open' AND source_type='simulated';
-- 最终备份行数：786（首次 759 + 停止模拟器前间隙新生成 27）
```

### 3.2 关闭模拟测试告警（仅 simulated + open）
```sql
UPDATE ewoh_event SET status='closed', _updated_at=now()
WHERE status='open' AND source_type='simulated';
-- 首次 UPDATE 759 行；补清 27 行；合计关闭 786 行
```

### 3.3 规则优化 / 模拟数据源开关（治本「不再堆积」）
1. **即时停止**（免重启，可逆）：`POST /api/simulator/stop`（admin token）→ 返回 `running:false`，自容器启动已运行 ~23 分钟、生成 255 事件。
2. **持久化关闭**（防重启再生）：编辑 ECS `/opt/ewoh/.env`
   ```
   EWOH_SIMULATOR_ENABLED=1  →  0     # 恢复 fail-closed 默认（未显式启用不自动启动）
   EWOH_SIMULATOR_DISABLED=  →  1     # 双保险，即便显式启用也被 start() 拒绝
   ```

---

## 四、执行后验证（证据）

| 校验项 | 结果 |
|--------|------|
| simulated open 数 | **0** |
| 再生校验（停模拟器后） | **0**（无新 simulated 事件） |
| 剩余 open 总数 | **7**（inference 5 + simulation 2，**全非 simulated，正确保留**） |
| 备份表 `ewoh_event_sim_open_bk_20260823` | 786 行（可随时回滚） |

```sql
SELECT count(*) FROM ewoh_event WHERE status='open' AND source_type='simulated';  -- 0
SELECT source_type, count(*) FROM ewoh_event WHERE status='open' GROUP BY source_type;
--  inference 5 / simulation 2
```

API 侧（`/api/alerts`，近 24h/上限 500）现在仅返回 7 条非 simulated open 告警，模拟测试积压已清零。

---

## 五、待人工复核项（未充分验证，不臆断关闭）

剩余 **7 条非 simulated open 告警**需业务/安全角色判定：
- **inference 5 条**：AI 推理生成事件，可能为真实业务信号。
- **simulation 2 条**：模拟运行（what-if）派生，非演示模拟器持续流。

建议：由安全/业务负责人在告警页逐条确认/处置，不应由自动化脚本关闭。

---

## 六、规则优化建议（后续）

| 优化项 | 说明 | 状态 |
|--------|------|------|
| 模拟数据源开关 | 生产环境 `EWOH_SIMULATOR_ENABLED=0`（已落地） | ✅ 已执行 |
| 2h 自动过期 | `RetentionService.expireStaleSimulatedEvents` 已有，模拟器停后生效 | ✅ 生效中 |
| 事件去重 | `EWOH_SIM_EVENT_DEDUP_MS=600_000`（10min）已配置 | ✅ 已配置 |
| 告警限流 | 如需保留演示用模拟器，可进一步下调 `EWOH_SIM_MAIN_TICK_MS` 或限制事件类型 | ⏳ 可选 |

---

## 七、结论

- 模拟测试告警积压（786 条 open simulated）**已清零并验证不复发**（模拟器已停+持久化关闭）。
- 7 条非 simulated open 告警**保留待人工复核**，未误删/误关。
- 操作全程可逆（备份表 786 行 + 模拟器可随时 `start` 恢复）。

*执行方：告警与运维专员｜* *方法：DB 直查 + 备份 + UPDATE 关闭 + 模拟器开关*
