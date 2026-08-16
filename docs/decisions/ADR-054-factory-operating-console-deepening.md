# ADR-054：Factory Operating Console 深化（视口 culling 生产接线 + 暗色模式收口 + 页面级渲染测试，NO-13e）

- 状态：Accepted
- 日期：2026-08-16
- 关联：§17（前端 = Factory Operating Console，非 Dashboard）、
  §33（不猜/不伪造）、Task 4/P1（视口 culling 纯函数）、UX-00X
  （暗色模式助手/tokens 既有）

## 背景

factory-operating-console 矩阵缺口三项（逐实现读码复核）：

1. **视口 culling 闲置**：纯函数（viewportCulling.ts）与消费面
   （FactoryMap cullByBounds）+ store slice（viewport.visibleBounds）
   + 控制器 setter（setViewportBounds）**全部已备**，唯独生产接线
   断点——没有任何代码由当前 pan/zoom 变换推导可见范围并写入
   store（visibleBounds 恒 null → 默认全量渲染）。
2. **深色模式半成品**：contrastMode.ts 助手（applyDarkClass）+
   tokens.css 暗色令牌（[data-theme="dark"]）已备，但 index.tsx
   启动路径只接入了高对比模式，暗色从未接线（data-theme 恒不设置）。
3. **页面级渲染测试覆盖极低**：CommandMap 域仅有 VM/hook 测试，
   无地图视口页面的渲染 smoke。

## §29 十八问（实现前作答）

1. **Domain**：Factory Operating Console（§17 前端）。
2. **Canonical Contract**：无新契约——消费 viewportCulling 纯函数
   （单一事实源：世界坐标 ↔ 屏幕坐标变换语义）与既有 store slice。
3. **Authoritative Source**：变换数学 = viewportCulling.ts（本 ADR
   决策 1 公式，纯函数 + 单测锁定）。
4. **如何改变 Factory World**：不改世界状态——渲染性能面（视野外
   实体不渲染）+ 主题呈现面。
5. **Event**：无新事件（纯前端）。
6. **谁消费**：CommandMap 地图渲染（人员/设备/工位实体清单）。
7. **失败会怎样**：worldBoundsFromTransform 非法输入 → null →
   保持默认全量渲染（fail-safe 显式，§33 不猜）；上报循环以 bounds
   等值守卫（不变化不重复写 store，避免渲染循环）。
8. **离线会怎样**：纯前端（无网络依赖）。
9. **重复消息会怎样**：onTransformed 高频回调幂等（lastBounds 守卫）。
10. **权限边界**：无。
11. **租户边界**：无（渲染面）。
12. **安全风险**：无。
13. **Human Approval**：无。
14. **如何解释 Decision**：culling 边界 = 可推导变换数学（测试锁定）。
15. **如何测试**：worldBoundsFromTransform 纯函数 5 例（等比/meet
    居中/zoom/pan/非法输入）；MapViewport 渲染 smoke 3 例（模式
    分支/叠加层/接线面）。
16. **如何审计**：无运行时审计需求（纯呈现；culling 数学由单测锁定）。
17. **如何迁移**：无 DB/API/env 变更（additive props：
    onVisibleBoundsChange 缺省不启用，既有纯展示面不受影响）。
18. **如何回滚**：摘除 FactoryMap 上报回调 + Shell 接线即回滚
    （culling 回默认全量渲染——原行为）。

## 决策

### 决策 1：变换数学纯函数化（worldBoundsFromTransform）

xMidYMid meet + react-zoom-pan-pinch 内容变换的屏幕↔世界映射：
fit = min(containerW/vbW, containerH/vbH)；居中偏移 offsetX =
(containerW − vbW·fit)/2；worldX = (screenX − offsetX − positionX)/
(fit·scale) + vb.minX。非法输入（NaN/非正 scale/零尺寸）→ null
（调用方保持默认全量渲染）。纯函数 + 单测锁定（可推导/可审计）。

### 决策 2：culling 生产接线（FactoryMap → store 唯一写点）

FactoryMap += onVisibleBoundsChange 回调（onInit + onTransformed
上报，lastBounds 等值守卫防渲染循环）；MapViewport 透传；
CommandMapShell 接 ctl.setViewportBounds（store viewport.visibleBounds
唯一写点——与既有 slice/控制器语义一致，无第二事实源）。

### 决策 3：暗色模式启动接线（跟随系统偏好，无手动开关）

index.tsx 启动路径 applyDarkClass + prefers-color-scheme change 监听
（与高对比模式同结构）；tokens.css 暗色令牌既有。手动主题切换
（设置面板）为后续 UI 轮次（本轮只收口"系统偏好跟随"半成品）。

### 决策 4：页面级渲染测试技术栈 = renderToStaticMarkup（既有约定）

client 测试栈无 RTL（既有 .test.tsx 用 react-dom/server
renderToStaticMarkup）——渲染 smoke 沿用同栈；重依赖面板
（IntelligenceWorkspace/PlanCompareWorkspace）以受控替身隔离，
断言模式分支与接线面（不测试 react-zoom-pan-pinch 内部行为）。

## 后果

- 正：视口 culling 进入生产调用链（pan/zoom → 世界可视范围 →
   实体剔除，大地图渲染性能）；暗色模式半成品收口（系统偏好跟随 +
   令牌生效）；页面级渲染 smoke 建立（模式分支确定性锁定）。
- 负：手动主题切换未做（后续 UI 轮次）；culling 仅命令地图域
   （其他页面按需跟进）。
- 无破坏性变更（additive；culling 缺省同原行为；无 DB/API/env
   变更）。
