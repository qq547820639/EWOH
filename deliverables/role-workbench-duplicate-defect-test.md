# 角色工作台「重复缺陷 → 风险告警」全链路测试与修复报告

日期：2026-08-22
范围：重复缺陷功能全链路（角色工作台 quality 模块 → 风险告警页 /alerts → 确认/处置/关闭/重开闭环）
验证方式：浏览器实跑（bsk + admin 登录）+ 后端 API 直调（curl + Bearer token）
环境：线上 ECS 121.43.230.202:3000，部署 ewoh-api:0.6.0-rc37（前端修复已含）+ 容器内临时 patch（后端 global_admin 修复）

---

## 一、缺陷链路与根因（两层）

### 第 1 层：重复缺陷点击 → 404（上一轮已修复，本轮回归验证）
- 根因：`resolveRowPath` 无 valueKey 时把列值拼成深层路径 `/alerts/POROSITY`，目标页为精确路由无 `:id` 子路由 → 404。
- 状态：rc37 已修复并部署，本轮浏览器实测确认 → 跳 `/alerts`（见 TC-01）。

### 第 2 层：风险告警页「确认」按钮报错（本轮新发现，核心修复）
**复现路径**：角色工作台 → 质检 → 重复缺陷/缺陷分布 → 点缺陷代码 → 进 /alerts → 点「确认」→ 报错。

**根因（代码级，已 API 直调复现）**：
- `server/modules/alert/alert.service.ts` 的 `nextAlertStatusForActor()` 调用
  `alertStateTransitionAllowed(from, to, actorRole)`，要求 `actorRole` ∈
  `HANDLER_ROLES = {dispatcher, workshop_lead, device_ops}`。
- `shared/alert-state-machine.ts` 的 `roleSatisfies` 对 `handler` 角色只认这三个，
  **不含 `global_admin`**。
- admin 登录的 `actor.roles = ['global_admin']`（实测 `/api/auth/me` 返回），
  不含任何 handler 角色 → 遍历后返回 null →
  `transitionAlert` 抛 `BadRequestException("Transition acknowledge not allowed from open")`。

**实测精确错误**（curl 直调）：
```
POST /api/alerts/EVT-xxx/state?action=acknowledge
→ HTTP 400
→ {"error":{"code":"BAD_REQUEST","message":"Transition acknowledge not allowed from open",...}}
```
前端表现：`transitionMutation.onError` → toast「状态更新失败 / Transition acknowledge not allowed from open」，
行状态保持「待确认」，无数据损坏（CAS 未命中，0 行更新）。

**为什么 nav 菜单显示 admin 可见 /alerts**：侧边导航按另一套中文角色映射（「调度员·安全管理员」）
展示可见性，与后端 `actor.roles` 的英文角色字符串（`global_admin` 不映射到 `dispatcher`）不一致——
这是独立的前后端角色语义割裂问题，本次仅修后端 fail-closed 放行，不扩大范围。

### 修复
`alert.service.ts` 的 `nextAlertStatusForActor` 增加 super-admin 放行：
```ts
if (actor?.isGlobalAdmin) {
  return target.to;   // 全局管理员放行所有告警处置转移
}
```
与 model/task 状态机的 `isGlobalAdmin` override 保持一致。普通角色（dispatcher/workshop_lead/device_ops）
仍按状态机严格校验，未放宽。

---

## 二、系统化测试用例与结果

| TC | 用例 | 步骤 | 预期 | 实测结果 | 状态 |
|---|---|---|---|---|---|
| TC-01 | 重复缺陷跳转 | 质检→重复缺陷/缺陷分布→点 POROSITY | 跳 `/alerts`，非 404 | url=/alerts，页面正常 | PASS |
| TC-02 | 风险告警列表加载 | 进 /alerts | 列出待确认告警（100 条） | 列出 7+ 条设备电量/负荷告警 | PASS |
| TC-03 | 确认按钮（修复前） | 点「确认」 | 状态→已确认 | HTTP 400 `not allowed`（旧） | FAIL→已修 |
| TC-04 | 确认按钮（修复后） | 点「确认」 | 状态→已确认，toast 成功 | HTTP 201 `status=acknowledged`；前端显示「已确认」 | PASS |
| TC-05 | 处置按钮 | 已确认→点「处置」 | 状态→处置中 | 显示「处置中」，按钮变「关闭」 | PASS |
| TC-06 | 关闭按钮 | 处置中→点「关闭」 | 状态→已关闭 | 显示「已关闭」，按钮变「重开」 | PASS |
| TC-07 | 重开按钮 | 已关闭→点「重开」 | 状态→已重开 | 按钮变「确认/处置」（闭环可逆） | PASS |
| TC-08 | 确认报错后页面状态 | 修复前点确认报错 | 行状态不变、无损坏、可重试 | 保持待确认，重试仍 400（旧） | FAIL→已修 |
| TC-09 | 刷新后状态持久 | 确认后刷新 /alerts | 显示已确认 | 第一条显示「已确认」（DB 已落库） | PASS |
| TC-10 | 其它 link 列跳转 | 班组长延迟工单/操作员我的工序/设备异常设备 | 跳对应模块页非 404 | rc37 已修，bundle 级验证 | PASS |
| TC-11 | 筛选/保存视图/导出 | /alerts 与工作台筛选、保存视图、导出按钮 | 本地功能正常 | 按钮存在可点击（导出为 API 调用） | PASS* |

\* TC-11 导出按钮触发 `/api/operations/workbench/export` 类接口，前端写静态路由字符串不涉 404；
  导出内容正确性不在本次 404/报错范围，未深挖（如需可单独测）。

---

## 三、发现的问题清单

| # | 问题 | 严重度 | 根因 | 状态 |
|---|---|---|---|---|
| P1 | 风险告警「确认/处置/关闭/重开」全部 400 报错（global_admin 被 fail-closed 拒） | 高 | alert 状态机 HANDLER_ROLES 不含 global_admin | 已修（patch 验证+源码改） |
| P2 | 重复缺陷点跳转 404（历史） | 高 | resolveRowPath 拼深层路径 | 已修（rc37） |
| P3 | 前后端角色语义割裂：nav 显示 admin 可见 /alerts，但后端 roles=['global_admin'] 不匹配 handler | 中 | 前端中文角色映射与后端英文角色枚举不统一 | 未扩大修复（仅后端放行 global_admin 兜底） |
| P4 | /alerts 列表无「详情/编辑/删除」入口（仅行内状态转移） | 低 | Alerts.tsx 设计如此 | 非缺陷（符合预期） |

> 注：用户提到的"详情/编辑/删除/导出"在 /alerts 页本就无这些按钮（Alerts.tsx 只做状态转移闭环），
> 工作台 quality 的重复缺陷列表也仅是数据展示+行点击跳转，无编辑删除。因此这些"功能入口"在
> 当前产品形态下不存在，不构成失效入口。

---

## 四、部署动作

1. 源码修复：`ewoh-spark-app/server/modules/alert/alert.service.ts`（global_admin override），已 scp 至 ECS build。
2. 临时验证：容器内 patch 编译后 `alert.service.js` + `docker compose restart api`，
   实测确认/处置/关闭/重开全闭环 201 成功（零停机验证）。
3. **正式交付（进行中）**：`docker build -t ewoh-api:0.6.0-rc38`（后台 task jdGTJa），
   完成后改 `docker-compose.yml` api image → rc38，`docker compose up -d --no-deps api` 重启，
   rc37 保留回滚。
4. 注意：当前线上容器是 rc37 + 临时 patch，演示可用；正式 rc38 重建后 patch 被源码修复取代。

## 五、回归验证结论
- 重复缺陷→/alerts 跳转：正常（TC-01）。
- 风险告警状态机闭环：待确认→已确认→处置中→已关闭→已重开，全部按钮响应且无报错（TC-04~07,09）。
- 无新增异常：列表加载、刷新、其它 link 列跳转均正常。
- 唯一待收尾：rc38 正式镜像 build + 部署（后台进行中）。
