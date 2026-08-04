# W2 波次报告：视觉资源链修复与产品级设计系统

> 波次：W2（RC4 候选版本产品化深化）
> 时间：2026-08-04
> 分支：`main`；HEAD：`3f4ed4eac6a78e547eeea10c15dd5494aa0feeb6`
> Owner：交互设计负责人 / 首席软件架构师
> 前置：W1（只读审计与事实一致性）已完成

## 1. 发现的问题

| 编号 | 严重度 | 问题 | 处置 |
|------|--------|------|------|
| W2-1 | 高 | **生产构建 CSS 仅含主题变量，无 Tailwind 工具类**（`items-center`/`min-h-screen` 等缺失，CSS 仅 6.6KB），导致截图呈现浏览器默认 HTML | 已修复（见 W2-1 根因） |
| W2-2 | 高 | index.css 缺 `@import "tailwindcss"` 引导框架；`@config` 无法在 postcss 阶段加载外部 `.ts`；`@source` 路径/语法错误 | 已修复 |
| W2-3 | 高 | 无视觉质量门禁：静态资源 404、console error、未处理异常不会导致测试失败 | 已建立 |
| W2-4 | 中 | 设计 token 缺 motion（时长/缓动）体系 | 已补齐 |
| W2-5 | 中 | PermissionState 为局部组件、OfflineState 无共享组件 | 已抽为共享组件 |
| W2-6 | 中 | 视觉回归仅有 4 页 × 桌面视口，未覆盖 3 视口与 Git 同步/站点准备页 | 已扩展为 6 页 × 3 视口 |
| W2-7 | 中 | 无 axe 无障碍扫描；存在 serious/critical 违规（对比度、空 listbox） | 已引入 axe 并修复 |
| W2-8 | 中 | Events/Workers 旧页查询失败会误显示「空态」 | 已补 ErrorState 分支 |
| W2-9 | 低 | 视觉回归因 `QueryState` 实时时间戳（`更新于 HH:MM:SS`）导致截图像素漂移、间歇性失败 | 已用 `page.clock.install()` 冻结时钟 |

### W2-1 根因诊断
- 通过新增 `scripts/diag-visual.js` 诊断：登录页提交按钮 computed style 为默认样式，`document.styleSheets` 中 CSS 未含工具类。
- 确认根因：Tailwind v4 需 `@import "tailwindcss"` 引导；`@config` 无法加载外部 `.ts`；`@source` 需显式声明扫描路径。
- 修复后生产构建 CSS 由 **6.6KB → 218KB**，`items-center` 等工具类正确生成。

## 2. 完成的代码改动

- **W2.1 视觉资源链修复**：`client/src/index.css` 新增 `@import "tailwindcss"`、调整 `@source`，移除冲突的 `@config`；`tailwind.config.ts` 扩 content 扫描；新增 `scripts/diag-visual.js`。重建验证 CSS 工具类生成。
- **W2.2 视觉质量门禁**：新增 `test/browser/ux009-visual-gate.spec.js`，校验外链 CSS 加载、关键组件 computed style，阻断静态资源 404 / console error / pageerror。
- **W2.3 设计 token**：`client/src/tailwind-theme.css` 新增 motion token（duration fast/base/slow/slower + easing standard/in/out/emphasized），`@theme inline` 映射为 `duration-*`/`ease-*` 工具类。
- **W2.4 组件库**：新增共享 `components/PermissionState.tsx`、`components/OfflineState.tsx`；`CenterPlaceholder.tsx` 改用共享 PermissionState。
- **W2.5 多视口视觉回归**：改写 `test/browser/ux009-visual.spec.js` 为 6 页 × 3 视口 = 18 用例；新增 Git 同步/站点准备页 mock；生成 18 个基线 PNG；清理 4 个孤儿旧基线。
- **W2.6 axe 无障碍**：新增 `@axe-core/playwright`；新增 `test/browser/ux009-axe.spec.js`；修复 3 处 serious/critical 违规（`Layout.tsx` 导航对比度、`MobileWorkbench.tsx` 在线状态对比度、`WorkGraphPanel.tsx` 空 listbox）。
- **W2.7 页面状态全覆盖**：补 `Events.tsx`/`Workers.tsx` 错误态；新增 `test/browser/ux009-states.spec.js` 验证 loading/error/empty/offline/permission 五态。

## 3. 未完成项及真实原因

- **桌面端非移动页面无全局离线横幅**：仅 `MobileWorkbench` 与 `Layout` 顶栏有离线处理；其余桌面页依赖 `QueryState` 的 error 态呈现网络失败，因非移动页无离线队列语义，属设计取舍，非缺陷。
- **`authenticated.spec.js` 需真实 PostgreSQL 后端**：本机无该运行时，属外部环境验证，不伪造结果。
- **`ux009-work-orchestration.spec.js` Gate 撤销用例**：为既有 flaky 用例（等待 disabled 的「撤销」按钮），非本次改动引入，属 W3 深化范围。

## 4. 测试命令和结果

| 命令 | 结果 |
|------|------|
| `npm run type:check:client` | 通过 |
| `npm run stylelint` | 通过 |
| `npx eslint test/browser/ux009-*.spec.js --no-ignore` | 通过 |
| `NODE_ENV=production npx vite build --config vite.config.ts` | 构建成功（CSS 218KB） |
| `npx playwright test --config playwright.config.ts --grep "UX-009/VisualGate"` | **3/3 通过** |
| `EWOH_VISUAL=1 npx playwright test --config playwright.visual.config.ts` | **18/18 通过** |
| `npx playwright test --config playwright.config.ts --grep "UX-009/Axe"` | **4/4 通过** |
| `npx playwright test --config playwright.config.ts --grep "UX-009/States"` | **5/5 通过** |
| 完整 `--grep "UX-009"` 套件 | 36/37 通过（1 个既有 flaky：Gate 撤销） |

## 5. 前后截图

- 修复前：登录页/指挥中心/执行控制台在 `output/playwright/` 与 `ewoh-spark-app/output/diag-*.png` 呈浏览器默认样式。
- 修复后：`test/browser/snapshots/ux009-visual.spec.js/` 下 18 个基线截图（6 页 × mobile/tablet/desktop），视觉已应用设计系统。

## 6. 关键 Diff

- `client/src/index.css`：`@import "tailwindcss"` + `@source "./**/*.{ts,tsx,js,jsx,css}"` 等；移除 `@config`。
- `client/src/tailwind-theme.css`：新增 `--motion-duration-*`、`--motion-ease-*` 及 `@theme inline` 映射。
- `components/Layout.tsx`：导航激活态二级文字 `text-white/75 → text-white`（对比度 ≥4.5:1）。
- `components/MobileWorkbench.tsx`：在线状态 `text-emerald-600 → text-emerald-700`。
- `pages/WorkOrchestration/WorkGraphPanel.tsx`：空状态移除 `role="listbox"`（消除 `aria-required-children`）。
- `pages/Events/Events.tsx`、`pages/Workers/Workers.tsx`：补 `ErrorState` 分支。

## 7. 风险变化

- **下降**：生产构建 CSS 加载断裂（原高）已消除，界面呈现产品化水平。
- **下降**：视觉/无障碍/状态缺少自动门禁（原中高）已建立回归与阻断。
- **保持**：真实 PostgreSQL、Docker/K8s、真机、真实 GitHub 授权写入仍须外部条件，Pilot Readiness 保持 **NOT READY**。

## 8. Gate 状态变化

- 本地门禁新增：视觉质量门禁（3 项）、axe 无障碍（4 项）、页面状态（5 项）、多视口视觉回归（18 项）全部通过。
- 生产 Gate：G10–G13 仍须人类批准；Pilot Readiness 保持 **NOT READY**。本轮不改变任何生产 Gate 状态。

## 9. 下一波次依赖

- **W3（因果执行控制台 UX）**：依赖 W2 设计系统与视觉门禁；需深化工作编排信息架构、DAG、预设视图、Agent/资源页。
- **W4（GitHub 同步闭环）**：依赖 W2 设计系统；需真实 Token capability probe 与授权。
- **W5（移动工作台重构）**：可并行，独立模块。
- **W6（工厂上线向导）**：依赖 W2 设计系统。
- 遗留：`authenticated.spec.js` 需真实 PG 后端；`work-orchestration.spec.js` Gate 撤销用例随 W3 深化。

## 10. commit SHA

- W2.1 `ea68000`：修复视觉资源链根因
- W2.2 `07b3db1`：建立视觉质量门禁
- W2.3+W2.4 `85ec2b0`：补齐 motion token + 共享 PermissionState/OfflineState
- W2.5+W2.6 `48cb932`：多视口视觉回归 + axe 无障碍 + 修复违规
- W2.7 `3f4ed4e`：页面状态全覆盖 + 清理孤儿基线
- 当前 HEAD：`3f4ed4eac6a78e547eeea10c15dd5494aa0feeb6`