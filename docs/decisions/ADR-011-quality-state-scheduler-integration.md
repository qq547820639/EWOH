# ADR-011：Quality State 入调度（Quality Incident Loop 调度消费语义）

- **状态**：Accepted
- **日期**：2026-08-16
- **阶段**：Phase 6 — Closed-loop Operations（NO-05d，Quality Incident Loop 收口）
- **关联**：总提示词 §4（QualityFinding 实体）/§8（Scheduler 输入含 Quality State）/
  §18（可解释性）/§36（自我审查）；ADR-006（Identity）/ADR-007（Risk）/
  ADR-010（Maintenance/Quality 领域模型 + AD-LC-005 维护封锁语义）

## Context（现状证据，2026-08-16 实测）

- NO-05b 已落地 ewoh_quality_finding（standalone_034，TENANT_SCOPED RLS +
  disposition-required CHECK）+ 云侧 Quality 模块（create/list/transition，
  QualityFindingDetected/Dispositioned 信封事件）。
- NO-05c 已把维护状态入调度（ResourceProjection 状态收敛 + Eligibility 封锁）；
  **质量状态尚未进入调度输入**：一个 critical 的 process_deviation 发现（links 指向
  工位）不会阻止该工位继续被派工——Quality Incident Loop 未闭环。
- 既有事实：QualityFinding.links 是规范身份数组（ADR-006，订单/工位/设备/物料/
  批次等），disposition ∈ {accept, rework, scrap, return}，生命周期
  open→under_review→dispositioned→closed。

## Decision（决策）

### 1. 活跃质量事实视图（QualityFindingProjection）

调度只读消费 ewoh_quality_finding 的**活跃**发现：status ∈ {open, under_review}
（dispositioned/closed 是处置终态，不参与封锁——处置即解除，由 Quality 模块
生命周期强制）。视图字段：findingId / findingType / severity（Canonical Risk
阶梯）/ status / disposition / links / detectedAt。

### 2. 封锁规则：严重度门控（critical/high 硬封锁，medium/low 仅事实可见）

| severity | 调度行为 | 理由 |
|---|---|---|
| critical | 关联资源硬封锁（*_quality_blocked 拒派） | 安全/质量红线，human-in-the-loop |
| high | 关联资源硬封锁（*_quality_blocked 拒派） | 高影响，human-in-the-loop |
| medium / low | 不封锁；仅以 qualityFindings 事实附着于资源投影（可见、可审计） | 工厂常态缺陷，硬封锁会造成整线停滞（工业现实约束） |

- **关联范围**：finding.links 中 kind ∈ {station, device, person} 的规范身份 →
  对应资源封锁（工位/设备/人员）。kind ∈ {order, material, batch, …} 的链接是
  被检对象而非调度资源，不产生资源封锁（留给 NO-05e MES/工单闭环消费）。
- **与维护封锁的语义差异（显式声明）**：维护条件 → 资源自身状态收敛
  （critical→OFFLINE / 其余→DEGRADED，AD-LC-005）；质量发现 → **不改变资源状态**，
  仅资格封锁（质量发现不改变资源物理可用性，只改变"是否允许派工"这一决策）。
  两者都以 fail-closed 方向保守（宁可少派，不可错派）。
- **人审解除路径**：dispositioned/closed（Quality 模块转移，Dispositioned 事件
  落库）→ 投影自然解除封锁。不需要独立"解锁"动作，避免第二套状态源。

### 3. 消费路径（与 NO-05c 同构）

- `ResourceProjectionService.loadActiveQualityFindings()`：读表 + 形状守卫 +
  活跃过滤，按 links 中资源 kind 建 `Map<entityId, QualityFindingProjection[]>`；
- `project()` / `projectForSnapshot()`：persons/devices/stations 附着
  `qualityFindings`（可选字段，无则 null，不伪造）；
- `EligibilityService`：候选 person/device/station 存在 critical/high 活跃发现 →
  `person_quality_blocked` / `device_quality_blocked` / `station_quality_blocked`
  （candidate-engine 建 stationQualityBlockedById，与 NO-05c 同构）。

### 4. 后果（Consequences）

- 正面：Quality Incident Loop 闭环——质量发现 → 事件 → 调度封锁 → 处置 → 解除，
  全程可审计（eligibility reasons + ewoh_event + disposition 转移）。
- 负面/代价：medium/low 不封锁是业务判断（可配置化留待 NO-05f 质量封锁策略契约，
  当前为固定语义并如实写入本 ADR，不伪装成策略系统）。
- 无新表/无迁移：ewoh_quality_finding 已存在（standalone_034）。

## Rejected Alternatives（否决方案）

1. **任何活跃发现一律封锁（与维护同规则）**：medium/low 缺陷在真实工厂是常态，
   全量封锁会导致整线停滞、调度失效；违背"调度可用性"目标。
2. **按 links 全部 kind 封锁（含 order/material）**：order 是任务对象不是执行
   资源，封锁语义无法落点；且会造成"订单有缺陷 → 全部资源被锁"的传染性误锁。
3. **质量发现改变资源状态（OFFLINE/DEGRADED）**：质量事实不改变资源物理可用性，
   状态收敛必须诚实反映物理/维护事实，质量只改变派工决策（Decision 层），
   混入状态层会造成资源状态语义膨胀。
