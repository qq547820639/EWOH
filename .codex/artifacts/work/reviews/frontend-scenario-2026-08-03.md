```yaml
review_status: fail
severity_counts:
  critical: 0
  major: 5
  minor: 10
  suggestion: 5
anchor_alignment:
  status: aligned
  notes: "Scope fully covered: routes/pages/API layer/Layout, Command Map (modes/L0-L4/2D-3D/replay/drill-down), SP-01..SP-08 classification, UI CSS/TSX risks. type:check and scenario spec executed; no source files modified."
plan_challenge:
  status: none
  notes: "N/A - independent verification task; no agent plan to challenge."
repeated_error_patterns:
  - pattern: "decorative interactions (controls/actions that visibly do nothing)"
    count: 5
    evidence:
      - "TimelinePanel.tsx:30-31,111-134 speed/pause state never drives playback"
      - "WorkbenchPanel.tsx:207-236 quick actions only toast '请切换到…标签页'"
      - "BrainPanel.tsx:167-175 accept only toasts, claims jump without navigating"
      - "CommandMap.tsx:169-174 view/handle handlers ignore eventId"
      - "useKeyboardShortcuts.ts:69-72 Space toggles replay mode, not pause"
    recommended_loop: L2_strategy
  - pattern: "auth/role/user identity absent client-side"
    count: 4
    evidence:
      - "Layout.tsx:34-112 roles metadata never filters nav items"
      - "app.tsx:8-45 no route guard; lib/auth.ts:22 isAuthenticated unused"
      - "lib/http.ts:1-31 no 401 interceptor; refresh() never called"
      - "ResourcePoolPanel.tsx:399 / TaskOrchestrationPanel.tsx:114 / AiDecision.tsx:17 hardcoded operator 'commander'/'demo-user'"
    recommended_loop: L1_understanding
  - pattern: "unused/dead scaffolding and duplicated query keys"
    count: 4
    evidence:
      - "hooks/queryKeys.ts:1-14 org-scoped helper imported by no page"
      - "pages/Overview, Events, Workers, CenterPlaceholder not routed/imported"
      - "CommandMap.tsx:86-104 ad-hoc keys duplicate Devices.tsx:91-98 keys for same endpoints"
      - "package.json:27 test:e2e points to missing test/e2e/jest.config.js"
    recommended_loop: L2_strategy
defects:
  - severity: major
    file_or_symbol: "client/src/pages/CommandMap/panels/TimelinePanel.tsx:30-134 + FactoryMap.tsx:13-14,679-683"
    issue: "Replay is cosmetic only: speed/paused state never drives playback, no animation loop exists, and FactoryMap renders live worldState regardless of replayTime (replay only changes a badge). Space key is documented as pause/continue but toggles replay mode (useKeyboardShortcuts.ts:69-72)."
    impact: "The headline '回放' feature cannot verify any historical state; users believe they are inspecting a past moment while seeing live data. Core scenario-realism claim fails."
    recommendation: "Either implement a real scrubber that feeds a historical snapshot set into the map (render snapshots nearest to replayTime in FactoryMap/FactoryMap3D), or rename/remove the replay mode and inert speed/pause controls."
    evidence: "TimelinePanel.tsx:30-31 (speed/paused state), 111-134 (controls), FactoryMap.tsx:679-683 (replay only renders a badge); useKeyboardShortcuts.ts:69-72"
  - severity: major
    file_or_symbol: "client/src/pages/CommandMap/CommandMap.tsx:169-174,275 + panels/EventCenterPanel.tsx:58-77"
    issue: "Event drill-down/handling is not wired: AlertToast passes eventId but CommandMap handlers ignore it and only switch tabs; EventCenterPanel keeps selectedId internal and has no action buttons, although POST /api/dashboard/events/:eventId/handle exists (server/modules/dashboard/dashboard.controller.ts:113). Timeline event markers are not clickable either."
    impact: "从告警浮层/时间轴的 '查看详情' 与 '快速处置' 都无法定位到具体事件，处置动作不存在，告警闭环在指挥地图内不可用。"
    recommendation: "Thread eventId into EventCenterPanel as external selection (prop or URL state) and add acknowledge/handle actions backed by the existing API."
    evidence: "CommandMap.tsx:169-174 (handlers only setActiveTab), AlertToast.tsx:126-151 (view/handle callbacks), EventCenterPanel.tsx:63-64,180-204 (internal selection only, read-only detail)"
  - severity: major
    file_or_symbol: "client/src/components/Layout.tsx:34-112,150-190 + client/src/app.tsx:8-45"
    issue: "Role-gated navigation is metadata-only: all 12 nav items render for every user (roles only in title/data-roles), no route guard wraps pages, isAuthenticated() (lib/auth.ts:22) is never used, and 403/401 render as raw axios error strings on every page. Client never stores the logged-in user or roles (Login.tsx:20 stores only tokens)."
    impact: "Any authenticated user sees all centers; permission-denied and stale-session states are absent; hardcoded operator identities ('commander', 'demo-user') also pollute audit attribution."
    recommendation: "Persist AuthUser.roles after login, filter nav and guard routes by role, add a 403 page state, and derive operator from the authenticated user instead of constants."
    evidence: "Layout.tsx:161-162 (title/data-roles only), app.tsx:12-42 (no guard), Login.tsx:17-20 (roles discarded), ResourcePoolPanel.tsx:399"
  - severity: major
    file_or_symbol: "test/scenarios/scenario-packages.spec.ts:16-190"
    issue: "SP-01..SP-08 are all in-process unit tests over in-memory services or subprocess --plan SQL generation; none exercises HTTP, a real database, auth/roles, or the frontend. package.json:27 'test:e2e' points to a non-existent test/e2e/jest.config.js. No client-side tests exist anywhere in client/."
    impact: "These packages cannot be called E2E acceptance: DB persistence, guards, serialization, and UI flows are unverified; the e2e script fails outright."
    recommendation: "Add a supertest harness bootstrapping the Nest app against demo.db/Postgres with seeded data and real login, plus at least smoke tests for the 11 routes; classify the current spec as unit-level in CI naming."
    evidence: "SP-01:16-24, SP-02:26-44, SP-03:46-56, SP-04:58-71, SP-05:73-82, SP-06:84-90, SP-07:92-99 (private chains map accessed via cast), SP-08:101-190 (plan-mode only); no test/e2e dir; npx jest test/scenarios/scenario-packages.spec.ts passes 8/8 in 6s"
  - severity: major
    file_or_symbol: "client/src/pages/CommandMap/FactoryMap3D.tsx:10,165"
    issue: "L2 3D view ignores the active map mode entirely (mode prop unused; entityColor has no mode parameter), so 9 modes silently do nothing at L2; there is also no WebGL/3D fallback, so a Canvas failure takes down the whole CommandMap (only global ErrorBoundary)."
    impact: "Mode switching has no effect in the flagship 3D twin; mode/level semantics are inconsistent across L0-L4 and degrade situational-awareness claims."
    recommendation: "Pass mode into FactoryMap3D coloring/visibility (reuse getEntityColor semantics) or disable non-applicable modes at L2 with a hint; add an error-boundary fallback to the 2D map."
    evidence: "FactoryMap3D.tsx:10 (mode prop), 165 (destructured, unused), 16-32 (entityColor without mode)"
  - severity: minor
    file_or_symbol: "client/src/pages/CommandMap/panels/WorkbenchPanel.tsx:207-236 + BrainPanel.tsx:167-175"
    issue: "Quick actions and '采纳' show informational toasts instead of performing/ navigating the promised action."
    impact: "Interactions appear broken; users must manually switch tabs; accept flow ends without creating/opening a plan."
    recommendation: "Pass a tab-switch callback into WorkbenchPanel; have BrainPanel navigate to the plan or call a real accept API."
    evidence: "WorkbenchPanel.tsx:209,218,227,234 (toast.info), BrainPanel.tsx:169-174"
  - severity: minor
    file_or_symbol: "client/src/pages/CommandMap/panels/TaskOrchestrationPanel.tsx:302-359"
    issue: "Node edit/delete buttons use group-hover:opacity-100 but no ancestor carries the 'group' class, so they are permanently opacity-0 (still clickable but invisible)."
    impact: "工序编辑/删除入口不可见，只能靠误点击；可发现性差。"
    recommendation: "Add 'group' to the node container (and visible affordance), or drop the hover-only visibility."
    evidence: "TaskOrchestrationPanel.tsx:302 (node div without group), 359 (opacity-0 group-hover:opacity-100)"
  - severity: minor
    file_or_symbol: "client/src/pages/CommandMap/panels/ResourcePoolPanel.tsx:147-153,221-224,388-392"
    issue: "Device battery renders 0% when unknown (redundant ternary always falls back to null -> 0), and assignedWorkstationId is never loaded from real bindings, so '已分配' only reflects pending local allocations."
    impact: "资源池显示误导性的 0% 电量且不反映真实绑定关系，AI 分配评估基于不完整状态。"
    recommendation: "Show '—' for unknown battery and hydrate assignments from device binding data (getDeviceBindings) or world state."
    evidence: "ResourcePoolPanel.tsx:147-153 (ternary both branches null), 221-224 (assigned lookup never populated), 388-392"
  - severity: minor
    file_or_symbol: "client/src/pages/Scheduling/Scheduling.tsx:20-66 + DataAssets/DataAssets.tsx:13-52"
    issue: "Scheduling center is a read-only plan list while its header promises 生成/确认/执行跟踪 (generate/confirm/audit UIs live only inside CommandMap SchedulePanel); DataAssets header promises 数据源健康摘要 but shows only two counts."
    impact: "中心页与描述不符，功能分布失衡；数据资产页实为占位级页面。"
    recommendation: "Add generate/confirm controls to Scheduling or adjust copy; add real data-source health or rename the page section."
    evidence: "Scheduling.tsx:8-9 (header), 24-26 (getPlans only); DataAssets.tsx:17 (header), 27-49 (counts only)"
  - severity: minor
    file_or_symbol: "client/src/pages/DigitalWorld/DigitalWorld.tsx:53-95"
    issue: "No empty state for the hierarchy tree (blank section when no nodes), selection shows only the entity ID (no detail/name lookup), and the fetch has no unmount-cancellation guard."
    impact: "空数据与选中态反馈不足；组件卸载后 setState 竞态警告风险。"
    recommendation: "Add a tree empty state, render selected entity details, and add a cancelled flag like CommandCenter."
    evidence: "DigitalWorld.tsx:53-57 (no empty branch), 84-90 (ID only), 29-48 (no cancel guard)"
  - severity: minor
    file_or_symbol: "client/src/pages/CommandCenter/CommandCenter.tsx:20-40 (+ Alerts/Personnel/System/ModelManagement/Organization/DataAssets/AiDecision/Scheduling/DigitalWorld)"
    issue: "9 of 11 center pages use single-shot useEffect fetches with no refetch, polling, or stale-while-revalidate; react-query with refetchInterval is used only in Devices and CommandMap panels."
    impact: "指挥中心等页面数据在挂载后即过期（事件/告警/负荷不会更新），与实时操作系统的定位不符。"
    recommendation: "Standardize center pages on react-query with sensible refetchInterval/staleTime (as Devices.tsx:91-104 does) and the shared queryKeys helper."
    evidence: "CommandCenter.tsx:20-40 (Promise.all once), Devices.tsx:91-104 (refetchInterval 30000)"
  - severity: minor
    file_or_symbol: "client/src/pages/Personnel/Personnel.tsx:30-48"
    issue: "Search fires a request per keystroke with no debounce; requests are not aborted (only stale responses dropped)."
    impact: "快速输入时产生大量请求，浪费带宽且后端查询压力放大。"
    recommendation: "Debounce keyword (e.g., 300ms) before calling listPersonnel."
    evidence: "Personnel.tsx:33-46 (useEffect [keyword])"
  - severity: minor
    file_or_symbol: "client/src/lib/http.ts:1-31 + api/auth.ts:18-29"
    issue: "No 401 response interceptor; refresh() is never invoked; expired access token leaves every page showing raw 'Request failed with status code 401'; no logout/clearTokens call exists."
    impact: "会话过期后用户无感知、无自动续期、无登出入口，只能手动清 localStorage 或重登。"
    recommendation: "Add a 401 interceptor that calls refresh once, retries the request, and redirects to /login on failure; surface a logout control."
    evidence: "http.ts:14-30 (request interceptor only), refresh defined but unreferenced (rg confirms no callers)"
  - severity: minor
    file_or_symbol: "client/src/pages/Overview, Events, Workers, CenterPlaceholder + hooks/queryKeys.ts"
    issue: "Overview/Events/Workers pages and CenterPlaceholder are not routed or imported anywhere; queryKeys.ts is imported by no page; CommandMap/Devices use ad-hoc keys for the same endpoints."
    impact: "Dead code inflates review surface; query-key duplication means invalidations do not cross components (e.g., Devices invalidation does not refresh CommandMap)."
    recommendation: "Delete or route the orphan pages, adopt queryKeys, or centralize per-domain key factories."
    evidence: "app.tsx:12-42 (no imports); rg shows zero imports of Overview/Events/Workers/CenterPlaceholder/queryKeys"
  - severity: minor
    file_or_symbol: "client/src/pages/CommandMap/L3L4View.tsx:66-91"
    issue: "关联人员/关联设备 lists show global slices (first 8 persons/devices) not filtered by the focused entity, so '关联' labels are misleading at L3/L4."
    impact: "工位近景/人员跟随视图展示与焦点无关的数据，降低场景可信度。"
    recommendation: "Filter persons/devices by focus.entityId parent linkage (use entity.parentId or world-state references)."
    evidence: "L3L4View.tsx:66-69 (persons.slice(0,8) unfiltered), 78-83 (devices.slice(0,8) unfiltered)"
  - severity: minor
    file_or_symbol: "client/src/components/Layout.tsx:197-200"
    issue: "Footer hardcodes '外骨骼作业健康监测 v1.1.0 · 2026' with no version source; already inconsistent with product positioning."
    impact: "版本信息必然过期，误导验收。"
    recommendation: "Derive version from package.json/build info or remove the footer."
    evidence: "Layout.tsx:198-199"
  - severity: suggestion
    file_or_symbol: "client/src/pages/AiDecision/AiDecision.tsx:103-104"
    issue: "confirmItems rendered with key={item}; duplicate strings cause React key collisions."
    impact: "控制台警告与潜在渲染错位（重复建议项）。"
    recommendation: "Use index-suffixed keys."
    evidence: "AiDecision.tsx:103-104"
  - severity: suggestion
    file_or_symbol: "client/src/pages/Devices/Devices.tsx:253-270"
    issue: "Battery bar chart renders every deviceId on the X axis with fixed 12px ticks and no interval; dense device sets will overlap labels."
    impact: "图表可读性下降（标签重叠）。"
    recommendation: "Add tick interval/angle or tooltip-only labels."
    evidence: "Devices.tsx:260-266"
  - severity: suggestion
    file_or_symbol: "client/src/pages/CommandMap/FactoryMap.tsx:336-350,415-448"
    issue: "SVG entity labels at 9-11px are not truncated or collision-managed; dense workstations/devices will overlap text and bbox borders."
    impact: "地图视觉噪声；名称与实体错位。"
    recommendation: "Truncate labels to bbox width or hide below a zoom threshold."
    evidence: "FactoryMap.tsx:415-448 (workstation/device/person labels)"
  - severity: suggestion
    file_or_symbol: "client/src/pages/CommandMap/FactoryMap3D.tsx:201-202"
    issue: "No WebGL availability check or per-view error boundary; a 3D failure crashes the entire CommandMap."
    impact: "低端设备/无 WebGL 环境完全不可用。"
    recommendation: "Feature-detect WebGL and fall back to the 2D map for L2 with a notice."
    evidence: "FactoryMap3D.tsx:201-202 (Canvas render)"
  - severity: suggestion
    file_or_symbol: "client/src/tailwind-theme.css:1-70 + pages/*"
    issue: "Light pages are a one-note palette (white cards on hsl(220 14% 96%) with a single blue primary); radius 0.5rem is reasonable. CommandMap is a separate dark theme."
    impact: "视觉辨识度低，但非功能缺陷。"
    recommendation: "Introduce per-domain accent tokens (safety/red, scheduling/violet) if polish is desired; not required for correctness."
    evidence: "tailwind-theme.css:13-23, CommandMap.tsx:159-161"
final_recommendation:
  - fix_required
  - trigger_double_loop
```

---

# EWOH Frontend & Scenario Realism Audit — 2026-08-03

Verification agent report. Scope: `ewoh-spark-app/client/src/**`, `shared/api.interface.ts`, `test/scenarios/scenario-packages.spec.ts`. No source files modified (worktree left dirty). Evidence: `npm run type:check` passes (server+client); `npx jest test/scenarios/scenario-packages.spec.ts` passes 8/8 (6.2s).

## 1. Centers/routes: API reality vs placeholder

11 Layout centers + 1 standalone route. All 11 centers call real HTTP APIs (no page is a placeholder); `CenterPlaceholder.tsx` is a demo component not routed anywhere.

| Route | Page | Real API? | Loading | Empty | Error | Permission-denied | Stale-data handling |
|---|---|---|---|---|---|---|---|
| `/command-center` | CommandCenter.tsx | ✅ getOverview/getEvents | ✅ | ✅ (events) | ✅ | ❌ | ❌ (single fetch) |
| `/digital-world` | DigitalWorld.tsx | ✅ getHierarchy/getWorldState | ✅ | ❌ (tree blank) | ✅ | ❌ | ❌ |
| `/scheduling` | Scheduling.tsx | ✅ getPlans | ✅ | ✅ | ✅ | ❌ | ❌ |
| `/ai-decision` | AiDecision.tsx | ✅ createSuggestion/createPlan | ✅ | n/a | ✅ | ❌ | ❌ |
| `/devices` | Devices.tsx | ✅ searchDevices/getEntities | ✅ | ✅ | ✅ (via toast+table) | ❌ | ✅ react-query 30s |
| `/personnel` | Personnel.tsx | ✅ listPersonnel | ✅ | ✅ | ✅ | ❌ | ❌ |
| `/alerts` | Alerts.tsx | ✅ listAlerts/transitionAlert | ✅ | ✅ | ✅ | ❌ | ❌ |
| `/organization` | Organization.tsx | ✅ getOrganizationTree | ✅ | ✅ | ✅ | ❌ | ❌ |
| `/model-management` | ModelManagement.tsx | ✅ listModels/transitionModel | ✅ | ✅ | ✅ | ❌ | ❌ |
| `/data-assets` | DataAssets.tsx | ✅ listModels/listSystemConfigs | ✅ | n/a | ✅ | ❌ | ❌ |
| `/system` | System.tsx | ✅ listSystemConfigs | ✅ | ✅ | ✅ | ❌ | ❌ |
| `/command-map` | CommandMap.tsx (full-screen) | ✅ spatial/world/dashboard + gamification/scheduler | ✅ panels | ✅ | ✅ panels | ❌ | ✅ 2-30s polling |

API contract spot-checks passed: client `searchDevices` → `GET /api/dashboard/devices` matches backend controller params and `DeviceInfo[]` shape; `getEvents(limit,status)` matches; `shared/api.interface.ts` types are used consistently.

## 2. Command Map audit

- **Modes (9)**: `production/person/exoskeleton/body_load/safety_risk/device/environment/scheduling/data_quality` — real differentiation in 2D (FactoryMap.tsx:57-125), but **dead at L2 (3D)** (FactoryMap3D.tsx:165 unused `mode`). `environment` reads static `extra.env.temperature`, not the environment sensor API; `scheduling` mode draws a naive polyline through all persons (FactoryMap.tsx:390-397).
- **L0-L4**: L0/L1 → 2D (L1 adds camera FOV + UWB overlays), L2 → 3D twin, L3/L4 → list-style `L3L4View` (no camera/viewport). Level toggle cycles L0→L1→L2→L3→L4→L0 (CommandMap.tsx:136-138); help text in `useKeyboardShortcuts.ts` says "L0/L1/L2" (stale doc, minor).
- **2D/3D fallback**: none — no WebGL detection; a Canvas crash blanks the entire map (only global ErrorBoundary in index.tsx).
- **Interaction grammar**: 1-9/L/T/Space/Esc/F//? implemented (useKeyboardShortcuts.ts:49-80). **Space is documented as 暂停/继续回放 but toggles replay mode**; the TimelinePanel's own pause button controls an inert `paused` flag.
- **Replay**: scrubber with ticks + event markers + cyan cursor works for *selection*, but nothing plays: `speed`/`paused` are never read by any loop (TimelinePanel.tsx:30-31,111-134), and FactoryMap/3D keep rendering live `worldState` during "replay" (FactoryMap.tsx:679-683 badge only). Event markers are not clickable.
- **Event drill-down**: list→detail works inside EventCenterPanel; toast 查看详情/快速处置 pass `eventId` but CommandMap handlers ignore it (CommandMap.tsx:169-174); Feishu `?event_id=` opens the tab and selects the *entity*, not the event row; no handle/acknowledge action exists in the panel although `POST /api/dashboard/events/:eventId/handle` exists.

## 3. Scenario test classification (SP-01..SP-08)

All 8 pass under `npm test` but are **unit-level, not E2E**:

| ID | Classification | Evidence (scenario-packages.spec.ts) |
|---|---|---|
| SP-01 | unit (pure functions + in-memory tree) | :16-24 |
| SP-02 | unit (in-memory ResourceService/ApprovalService state machines) | :26-44 |
| SP-03 | unit (in-memory AiService; asserts snapshotVersion 0) | :46-56 |
| SP-04 | unit (in-memory ControlService) | :58-71 |
| SP-05 | unit (in-memory WorldCursorService) | :73-82 |
| SP-06 | unit (in-memory AuditChainService maps) | :84-90 |
| SP-07 | unit, white-box (casts service to reach private `chains`) | :92-99 |
| SP-08 | subprocess DDL runner in `--plan` mode; no DB connection; negative test uses invalid URL | :101-190 |

**Missing before they can be called true E2E acceptance**:
1. HTTP layer: no supertest/`Test.createTestingModule` app bootstrap anywhere in `test/`; `package.json:27` `test:e2e` references a non-existent `test/e2e/jest.config.js` (script fails).
2. Real database: all services exercised are in-memory (module-level `seq` counters, e.g. ai.service.ts:28-31); no demo.db/Postgres persistence, migrations, or RLS checks.
3. Auth/roles: no login flow, token, RolesGuard, or 403 assertions in scenarios.
4. Frontend: zero client-side tests (`client/` has no `*.spec.*`); no route/page smoke tests.
5. Isolation/cleanup: module-level counters shared across suites; SP-07 mutates service internals without restore.

## 4. UI risks (CSS/TSX reading)

- **Invisible controls**: TaskOrchestrationPanel edit/delete (`opacity-0 group-hover:opacity-100` with no `group` ancestor) — TaskOrchestrationPanel.tsx:302,359.
- **Label overlap**: Devices battery chart X axis (Devices.tsx:253-270); FactoryMap SVG 9-11px labels with no truncation/collision handling (FactoryMap.tsx:336-350,415-448).
- **Clipping**: fixed `h-[280px]` bottom panel (CommandMap.tsx:238) with 12-column SchedulePanel table — mitigated by internal `overflow-auto`; L3L4View 3-column grid in a short panel can clip sections (L3L4View.tsx:47-91).
- **Nested cards**: WorkbenchPanel uses cards inside cards (Card in Card) — acceptable visually; no overflow bug found.
- **Palette**: one-note light theme (white on `hsl(220 14% 96%)`, single blue primary; tailwind-theme.css:13-23) vs CommandMap's separate dark theme; radius `0.5rem` is fine, not oversized.
- **Icons**: consistent lucide usage; `kpi.icon` member-expression JSX is valid; no missing-icon crashes found. Badge/source chips have fallback labels.

## 5. Method & evidence

- Read: `app.tsx`, `Layout.tsx`, all `api/*.ts`, `lib/*`, all 12 routed pages + dead pages, all CommandMap components/panels, `shared/api.interface.ts`, `scenario-packages.spec.ts`, theme CSS, Tailwind config.
- Ran: `npm run type:check` (pass), `npx jest test/scenarios/scenario-packages.spec.ts` (8/8 pass, 6.2s).
- Verified backend contracts for the client calls used (dashboard controller/service; `POST /api/dashboard/events/:eventId/handle` exists).
- Did not run the app in a browser; visual claims are CSS/TSX-inferred only.
