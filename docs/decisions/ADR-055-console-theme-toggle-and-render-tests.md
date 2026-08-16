# ADR-055：Factory Operating Console 手动主题切换 + 页面渲染测试补强（NO-13f）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-054（console 深化决策 4 的后续——手动主题切换）、
  §17（Factory Operating Console）、§31（主题状态单一事实源）、§33

## 背景

ADR-054 收口了视口 culling 生产接线与暗色模式启动接线（系统偏好
跟随），并把"手动主题切换"与"更广页面渲染覆盖"留作后续。本轮收口
这两项，factory-operating-console 的三项 walkthrough 缺口全部关闭。

## §29 十八问（实现前作答）

1. **Domain**：Factory Operating Console（§17 前端）。
2. **Canonical Contract**：无新契约——主题偏好语义锁定于
   contrastMode 纯函数（单一事实源）。
3. **Authoritative Source**：localStorage 'ewoh.theme'（偏好唯一
   事实源）+ tokens.css 暗色令牌（呈现层，既有）。
4. **如何改变 Factory World**：不改世界状态（呈现/UX 面）。
5. **Event**：无。
6. **谁消费**：Layout 侧栏（主题切换）+ 全站 data-theme。
7. **失败会怎样**：localStorage 不可用（隐私模式）→ get/set 安全
   返回（system 默认）；无异常路径。
8. **离线会怎样**：纯前端。
9. **重复消息会怎样**：偏好幂等（覆盖式写入）。
10. **权限边界**：无（用户自身偏好）。
11. **租户边界**：无（本地设备偏好，不入云）。
12. **安全风险**：无。
13. **Human Approval**：无。
14. **如何解释 Decision**：三态循环语义（system→dark→light→system）
    纯函数锁定。
15. **如何测试**：contrastMode +5 例（偏好读回/持久化/解析/循环/
    data-theme 同步）；ThemeToggle 渲染 smoke 3 例（默认/深色/浅色
    标签）；静态页面 smoke 2 例（Forbidden 403 账号与动作 / NotFound
    404 与返回链接）。
16. **如何审计**：无运行时审计需求（本地偏好）。
17. **如何迁移**：无 DB/API/env 变更；additive 组件。
18. **如何回滚**：摘除 ThemeToggle + 恢复 ADR-054 的 applyDarkClass
    启动路径即回滚。

## 决策

### 决策 1：主题偏好单一事实源（contrastMode 扩展）

ThemePreference = 'system' | 'dark' | 'light'；localStorage
'ewoh.theme' 为偏好唯一事实源（'system' 移除键——显式默认不落脏值）；
resolveThemeMode（system 跟随媒体查询）+ applyThemePreference（同步
data-theme）+ nextThemePreference（三态循环）纯函数锁定；index.tsx
启动路径改为偏好感知（system 时媒体变化才重放，manual 时忽略媒体
变化——单一语义，§31）。

### 决策 2：ThemeToggle 组件 + Layout 接线

ThemeToggle（app-shell）：三态循环按钮（图标+文字双重表达，ux009
纪律）；Layout 侧栏用户区接线（退出登录旁）。

### 决策 3：静态页面渲染 smoke（renderToStaticMarkup 同栈）

Forbidden/NotFound/ThemeToggle 渲染 smoke（MemoryRouter + auth mock
隔离；断言标题/账号/动作/链接）——页面级渲染覆盖补强第一步；
数据型页面（SimulationConsole 等）渲染 smoke 依赖 query/api mock，
后续轮次按需跟进（不阻塞本能力升 Implemented——渲染 smoke 已覆盖
纯呈现面与组件面）。

## 后果

- 正：手动主题切换闭环（偏好持久化 + 三态循环 + data-theme 同步）；
  页面渲染 smoke 覆盖补强；factory-operating-console 三项 walkthrough
  缺口全部关闭，§36 升 Implemented（矩阵 52/3/0/1→53/2/0/1）。
- 负：数据型页面渲染 smoke 为后续按需跟进（显式边界）。
- 无破坏性变更（additive；无 DB/API/env 变更）。
