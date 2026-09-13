# 主产品闭环场景（真实 NestJS + PostgreSQL）

本页说明如何在本机把**主产品**（`ewoh-spark-app/` 的 React + NestJS + PostgreSQL）
的完整闭环跑起来并验证，而不是只验证 Edge 参考实现。Edge 侧的模拟闭环见
[本地故障重排闭环验证](local-closed-loop.md)。

闭环覆盖：**感知/派工 → 独立审批 → 下发 → 现场开始/完成回执 → 反馈与偏差 →
来源与训练资格 → 策略治理（Replay → SHADOW → Gate → 人审激活 → 回滚）**。

更新：2026-09-11。本文只描述**如何运行与如何判读**，不发布验收结论。

## DR-2~DR-6 全闭环验收（2026-09-11 新增：故障感知 → 数据质量确认 → 回滚 → 复盘）

`make e2e-fault-replan`（脚本 `ewoh-spark-app/test/e2e/fault-replan-retrospective.mjs`）
以"生产正常执行中突发设备故障"为叙事，对 2026-09-11 新增的五个能力做端到端断言
（真实后端 + 真实 PostgreSQL；消费可调度任务，运行前先 `make scenario-reset YES=1`）：

```sh
make scenario-reset YES=1      # 复位 seed 场景（ORG_ID 默认 seed 租户）
sleep 31                        # MANUAL 触发冷却 30s（TriggerService 去抖）
make e2e-fault-replan           # EWOH_E2E_* 环境变量同 e2e:golden
```

覆盖：班次解析（DR-2）→ 方案生成（3 候选）→ AI 解释留痕 → 独立审批（version +
snapshotVersion 契约形状）→ 派工 → 现场回执（STARTED→COMPLETED）→ 预计 vs 实际 →
故障事件感知（真实 ingest 通道 + 规范身份 subject）→ 数据质量确认（confirmed +
词表外 fail-closed，DR-4）→ 取消回滚（无原因被拒 / 部分回退 / 已执行不可回退如实
回报 / 终态重复取消 409，DR-5）→ 复盘六段组装 + 发布（DR-3）→ 世界快照扩展字段
（shifts/materials/orders，DR-6）。判读口径：PASS=断言通过；FAIL=失败；SKIP=前置
缺失（未验证 ≠ 通过）。

## 0. 一键启动（推荐入口）

```sh
make local-up                 # PG(docker) + 迁移链 + 种子 + 三账号 + 构建 + 启动
make local-up REBUILD_DB=1    # 先丢弃本地开发库再重建（只动 ewoh-pg-dev 容器里的库）
make local-up SKIP_BUILD=1    # dist 已是最新时跳过构建
```

脚本 `scripts/local-up.sh` 幂等，完成后输出三个本地账号与入口地址。
迁移链自身必须可重跑——2026-09-11 修复了两处破坏重跑的缺陷：

- `standalone_002_users` 的三个 SECURITY DEFINER 函数改为"不存在才创建"：
  `standalone_072` 会以 6 列形态（+person_id）重建 `ewoh_find_active_user`，
  PostgreSQL 不允许 `CREATE OR REPLACE` 改变返回类型，重跑 002 因此失败；
- `standalone_009` 的 no-overlap 验证改为同时接受最终形态
  （`standalone_022` 的 `..._person_device` EXCLUDE 约束）——全新安装上 009
  先于 017（建表）执行会被守卫跳过，旧验证只认旧约束名导致 fresh install 恒 FAIL。

手工路径（与脚本等价，便于排查）如下。

## 1. 前置：数据库与后端

需要一个本地 PostgreSQL（本仓库用一次性容器即可）与 owner 连接串。

```sh
# 一次性开发库（端口 55432，避免与既有实例冲突）
docker run -d --name ewoh-pg-dev \
  -e POSTGRES_USER=ewoh_owner -e POSTGRES_PASSWORD=devownerpw -e POSTGRES_DB=ewoh \
  -p 55432:5432 postgres:17-alpine

export EWOH_DATABASE_URL='postgresql://ewoh_owner:devownerpw@127.0.0.1:55432/ewoh'
export EWOH_ALLOW_DDL=1
export EWOH_API_DATABASE_PASSWORD='DevApiPassword#2026x'   # ≥16 位，迁移会建 ewoh_api 运行角色
export EWOH_BOOTSTRAP_ADMIN_USERNAME=admin
export EWOH_BOOTSTRAP_ADMIN_PASSWORD='DevAdmin#2026x'      # ≥12 位

# 迁移链（当前 70 个迁移）+ 校验 + 管理员
node db/runner/standalone-chain.js --apply
node db/runner/run_migrations.js --verify-standalone
node db/runner/run_migrations.js --seed-standalone-admin
# 调度场景数据（路线图 / 人员 / 设备 / 生产任务）
node db/runner/run_migrations.js --seed-standalone-scheduling
```

后端运行需要独立 env 文件（`ewoh-spark-app/.env.local-standalone`，含
`DATABASE_URL` 指向**非 owner** 的 `ewoh_api`、`JWT_SECRET`、接入密钥等）。
注意 `INGEST_API_KEYS` 这类 JSON 值必须整体加单引号，否则 `set -a; . .env`
的引号移除会把 JSON 吞掉（启动门禁会因此拒绝启动——这是有意的 fail-closed）。

```sh
cd ewoh-spark-app
npm run build:server
set -a && . ./.env.local-standalone && set +a
NODE_ENV=production node dist/server/main.js     # 默认 127.0.0.1:3100
curl -s localhost:3100/health/live
```

启动日志中的 fail-closed 提示是**正常**的：模拟器默认不启动、推送渠道未配置即显式关闭。

## 2. 运营账号：审批独立性要求至少两个身份

B5 审批独立性（`standalone_069` + `SELF_APPROVAL_FORBIDDEN`）规定**方案生成人不得
审批自己的方案**。因此闭环验证必须有两个身份；只有 bootstrap 单账号时，唯一账号
生成的方案它自己批不了。

```sh
export EWOH_DATABASE_URL=...   # owner 连接

# 审批人（调度员/班组长）
EWOH_OPERATOR_PASSWORD='ApproverLocal#2026x' \
  node db/runner/create-operator.js --username approver.li \
    --display-name '李审批' --roles dispatcher,workshop_lead

# 现场人员：--person-id 建立账号↔业务人员绑定
EWOH_OPERATOR_PASSWORD='FieldWorker#2026x' \
  node db/runner/create-operator.js --username worker.zhangwei \
    --display-name '张伟' --roles worker \
    --person-id 63000000-0000-4000-8000-000000000001

node db/runner/create-operator.js --list        # 查看角色与人员绑定
```

**账号↔人员绑定**（`ewoh_user.person_id`，随 JWT 签发）决定两件事，二者必须比较
同一标识空间：

- 现场回执的"本人可报"（`assignment.personId === ctx.personId`）；
- 现场作业台"我的任务"（`GET /api/scheduler/field/my-work`）。

未绑定的账号在这两条路径上都是 **403 fail-closed**，不会退化成"看不到"或"别人的
任务"。同一组织内一个人员只能绑定一个账号（唯一索引 `uq_ewoh_user_org_person`）。

## 3. 运行闭环场景

```sh
cd ewoh-spark-app
export EWOH_E2E_BACKEND_URL=http://127.0.0.1:3100
# 凭据必须与实际账号一致：make local-up 的默认口令为
#   admin/DevAdmin#2026x · approver.li/Approver#2026x · worker.zhangwei/Worker#2026x
# （下例展示的显式口令仅是占位，按你的账号替换；OPERATOR_USER 默认 approver.li，
#   传成 worker 口令会得到 401——2026-09-11 实测过的坑）
export EWOH_E2E_ADMIN_USER=admin          EWOH_E2E_ADMIN_PASS='DevAdmin#2026x'
export EWOH_E2E_APPROVER_USER=approver.li EWOH_E2E_APPROVER_PASS='Approver#2026x'
export EWOH_E2E_OPERATOR_USER=approver.li EWOH_E2E_OPERATOR_PASS='Approver#2026x'
export EWOH_E2E_FIELD_USER=worker.zhangwei EWOH_E2E_FIELD_PASS='Worker#2026x'
export EWOH_E2E_PG_URL='postgresql://ewoh_owner:devownerpw@127.0.0.1:55432/ewoh'

node test/e2e/golden-path-verify.mjs            # 或 make e2e-golden
node test/e2e/execution-receipt-closed-loop.mjs # 或 make e2e-receipt
node test/e2e/partial-dispatch-wave.mjs         # 或 make e2e-wave
node test/e2e/learning-proposal-governance.mjs  # 或 make e2e-learning
node test/e2e/edge-multisource-uplink.mjs       # 或 make e2e-edge
```

四者都是**三态**报告：`PASS` / `FAIL` / `SKIP`。`SKIP` 表示前置缺失、**未验证**，
不等于通过；只要存在 SKIP，退出码为 `2`（与断言失败的 `1` 区分）。判读时不要只看
PASS 数量。

连续跑多个场景时，**全局读接口限流**（`RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_SEC`，
默认 300/60s）会先触发：此时读列表返回 `429`，而"读不到方案"与"库里没有方案"
是两件事。脚本已区分这两种情况：限流时报 SKIP 并明确写出"限流不是没有数据"。
本地反复验证建议在后端 env 里放宽（生产按部署容量设定，勿照抄）：

```sh
RATE_LIMIT_MAX=5000
RATE_LIMIT_WINDOW_SEC=60
LOGIN_RATE_LIMIT_MAX=1000     # 登录限流默认 10/15min，反复登录会被挡
LOGIN_RATE_LIMIT_WINDOW_SEC=60
```

场景会消费可调度任务，反复运行后调度器就没有可排程任务了（表现为方案无
assignment：这是正确行为，脚本如实报 SKIP）。复位到已知起点：

```sh
# 预览（默认 dry-run）
node db/runner/reset-scenario-data.js --org-id 00000000-0000-4000-8000-000000000001
# 执行（或：EWOH_DATABASE_URL=... YES=1 make scenario-reset）
node db/runner/reset-scenario-data.js --org-id 00000000-0000-4000-8000-000000000001 --yes
```

**每个消费型场景（golden / receipt / wave）运行前都要先复位**：实测"golden 之后
直接跑 receipt"会因可排程任务已被派工而产不出可回执 assignment，脚本如实报 SKIP。
`e2e-learning` 不消费任务（自带模拟遥测与身份映射），顺序无关。

复位只处理 `source='seed'` 的任务及其派生的 plan/assignment/execution/feedback
与资源预约；审计日志、遥测、告警、非 seed 任务、学习提案台账不动。资源预约必须
一并释放，否则独占约束会让下一次派工撞 `STATION_CAPACITY`，场景无法重跑。

注意**孤儿预占**：若某方案的方案行已被更早的复位删除，其预占按 `plan_id` 再也
匹配不到，会永久占用 person/device（实测：剩余 8 条 reserved 导致调度器产不出
assignment、新方案为空）。复位脚本因此额外释放"方案行已不存在"的预占。

## 3.5 边缘多源上行（环境 / 摄像头 / UWB）

平台侧 `/api/ingest/{environment,camera,location}` 三个端点此前**从未被边缘喂过
数据**：边缘只把分组外骨骼帧转成存储行，环境/摄像头/定位帧因键不匹配在
`insert_telemetry` 处直接失败（只在日志里）。2026-09-10 收口后：

```sh
# 真实边缘运行时（真实适配器 → 归一化 → SQLite → 有界缓冲上行桥）+ 故障注入
python tools/edge_sensor_sim.py \
  --platform-url http://127.0.0.1:3100 --ingest-key <key> --org-id <org> \
  --suffix demo1 --duration-sec 6 --hz 1 --offline-first-sec 2 \
  --duplicate-rate 0.35 --reorder-rate 0.2 --late-rate 0.2 --drift-future-rate 0.2 \
  --workdir /tmp/ewoh-edge --stats-json /tmp/ewoh-edge/stats.json

# 端到端核对（平台侧事实断言需要 owner 连接串）
EWOH_E2E_OWNER_DATABASE_URL=... make e2e-edge
```

要点（完整契约见 [数据流 §3.5](../architecture/data-flow.md)）：

- **断网**：帧进有界队列（满时丢最旧 + `dropped_overflow`），恢复后 `retarget`
  原地续传；`/health` 暴露 `sensor_uplink`（buffer/stats）与 `frame_dead_letters`。
- **重放不双写**：平台按 `(org_id, scope, record_id)` 认领，重放返回 `skipped=true`；
  `world_state` 行同时落 `record_id` 以便事后核对。
- **迟到不丢弃，坏时钟不写**：落后 >10min 标记 `is_late`（质量降级）仍落库；
  超前 >5min 显式拒绝（`CLOCK_DRIFT_FUTURE_TS`）→ 边缘转死信文件。
- **"为什么没有可用资源"必须能回答**：指挥地图「冲突层」把求解器
  `violations[].rejectReasons` 按次数聚合成中文（例：`无法派工（规则求解器） ·
  没有合格候选资源 · 任务 T-2（候选拒绝：电量未知（未上报，不派工）×2、缺少设备能力）`）。
  核对口径：任何**码型**原因若显示为"未登记原因（key）"，说明有新的后端码没进
  `shared/reject-reason.ts` 词表——把它补进词表（或临时用未登记提示定位），
  绝不允许把裸英文码留给现场。
- **能力被误声明时怎么处置**（能力决定派工资格，错了不能只改库）：
  `POST /api/devices/<业务设备号>/capabilities/<能力名>/status`
  body `{"status":"disabled"|"active","reason":"<必填理由>"}`（200；幂等时 `changed=false`）。
  核对口径：停用后 `GET /api/scheduler/snapshot` 的该设备 `observedCapabilities`/
  `capabilities` **立即不含**该项；再发同类帧（摄入）**不得复活**该能力，
  且 `ewoh_device_capability.capability_value->'lifecycle'` 里的停用理由必须还在；
  设备详情 `capabilities[].lifecycle` 给出"谁/何时/为什么"；
  `ewoh_audit_log` 有 `device.capability.disable` / `device.capability.restore` 两行。
  恢复会被**权威契约校验**（词表外能力名拒绝恢复 409）。
- **浏览器验证前必须重建正确产物**：`test/browser/**` 与 `npm run e2e:check` 托管的是
  `dist/client`，它由 **`npm run build:client:standalone`**（vite.standalone.config.ts）
  产出；`npm run build:client`（vite.config.ts）产出的是主应用产物，**不会**刷新浏览器
  测试所用的 `dist/client`。改动 client 源码后若只跑 `build:client`，浏览器用例会对着
  旧 bundle 给出"假通过/假失败"（2026-09-10 实测：KPI testid 改动未生效、a11y 对比度
  违规在旧产物上忽隐忽现）。正确顺序：
  `npm run build:client:standalone && EWOH_BROWSER_MODE=mock npm run e2e:check`。
  真实后端用例另需 `EWOH_E2E_BASE=http://127.0.0.1:3100 EWOH_BROWSER_LOCAL_FIXTURE=1`。
- **浏览器 mock 必须与接口契约同形**：`GET /api/dashboard/events` 是 `{items,total}`
  而非裸数组、`GET /api/world/state` 必须有 `persons/devices/workstations/events`
  数组、`GET /api/dashboard/overview` 的 `avgLoad` 是 **0–1 归一化负荷**（UI ×100）。
  mock 用错形状会让页面崩成"页面加载失败"，看起来像产品缺陷。
- **模拟数据可识别**：帧以 `source_type=simulated` 落库（模拟器默认）。
- **能力被调度消费**：`GET /api/scheduler/snapshot` 的 `devices[]` 带
  `capabilities`（**执行/交互**能力名集，供 `requiredDeviceCapabilities` 匹配）、
  `observedCapabilities`（**观测**能力名集，供世界模型/AI 使用）与
  `capabilityRecords`（契约记录，含 subject/evidence）。三条核对口径：
  - 环境/摄像/定位类设备：`observedCapabilities` 非空而 `capabilities` **为空**
    （只"能看"不能"做"，不得为了让 UI 好看而伪造执行能力）；
  - 外骨骼：`capabilities` 至少含 `exo-lift`（型号派生）与 `interact.assist`
    （台账交互能力）——台账只声明观测/交互维度，**不得挤掉执行能力**，
    否则需要助力能力的任务永远无候选；
  - 台账缺口显式进 `capabilityProjectionIssues`。
  设备身份：调度键是 `id`（uuid），业务设备号在 `deviceId` 字段（边缘遥测/能力台账
  用业务号）——两者都给出，世界模型才能 join。
- **能力模型（对齐权威契约）**：能力记录写入前用 `validateCapability`
  （ADR-043 / `contracts/capability/`）**fail-closed 校验**：`kind` =
  `device_capability` / `exo_capability`，`providerType` = `device` / `exo`，
  `subject` = `device:<id>` / `exo:<id>`，`evidence` = 来源字段；观测/交互形态
  作为 `mode` 子属性保留（权威契约无此维度）。能力名（`observe.*` / `interact.*`）
  已登记进权威 `knownValues`，并有跨运行时字段对账门禁（改名即失败）。
  设备首次摄入即按类别声明能力（环境传感器 4 项观测、摄像头 3 项、
  定位 1 项、外骨骼 4 项含 1 项交互），写入 `ewoh_device_capability`（幂等，
  `(org_id, device_id, capability_key)` 唯一）；设备详情返回能力清单
  （含**词表外能力键原样展示**与"来源字段"），设备抽屉的"绑定关系"页可见。
  未登记类别**不声明任何能力**——宁可能力为空，也不猜它能观测什么。
- **感知设备进入平台设备台账**：环境传感器/摄像头/定位标签在首次摄入时登记
  `ewoh_device`（类别 `environment_sensor` / `camera` / `location_tag`），
  设备页、在线率与"最后通信"因此覆盖感知层；定位以物理标签 id（`tag_id`）登记，
  缺省回落 `entity_id`。**无电池设备电量保持 NULL**，设备页显示"不适用"而不是
  0% 低电量告警。设备页支持按类别过滤（`/api/devices?category=...`，
  旧 `/api/dashboard/devices` 同源）。
- **摄入限流**：`INGEST_RATE_LIMIT` / `INGEST_RATE_LIMIT_WINDOW_SEC`
  （默认 100/60s 不变）。多源机群共用一个边缘出口 IP，本地/产线部署需按机群
  规模上调（本地验证用 `INGEST_RATE_LIMIT=100000`），否则会被 429 拖成队列堆积
  （边缘会退避重试、不丢帧，但实时性下降）。

## 4. 现场作业台（外骨骼 / 现场人员视角）

前端路由 `/field-operations`（导航「作业现场 → 现场作业台」），面向班组长、
现场人员与外骨骼使用者：

- 顶部先说明**我是谁、数据多新**，再谈做什么；
- 本班概况与现场提醒（逾期 / 待开工 / 开工未完成 / 会话过期）；
- 每条提醒都带**来源端点、依据时间、可信度**；
- 内嵌回执行由 `field/my-work` 数据渲染，提交走统一回执端点；
- 数据过期时**停止**给出待办结论，只显示可信度告警。

边界：本页只读 + 回执，**不下发**任何关节、力矩、助力或限速指令；外骨骼的急停、
限扭、关节实时控制与失联安全态始终在设备控制器本地。显示"未绑定/无会话"仅表示
平台没有查到事实，不代表设备故障——会话请求失败时页面明确说明"绑定状态未知"，
不会把"读不到"渲染成"没有绑定"。

## 5. 学习段：评估 → 提案 → 影子 → 人审 → 回滚 / 时长模型重训

界面在 `/learning-console`（导航「学习控制台」）。这一层把此前只有后端、没有用户面的
学习治理链接通，并坚持三条边界。

### 5.1 训练样本资格：只有独立设备回执可训练

时长模型只由**独立设备回执**训练。资格判定是**两级**的，两级都必须满足：

1. **行级标记**：`receipt_source='real'`、`production_training_eligible=true`、且带 `provenance_json`；
2. **独立设备回执证据**：`provenance.policy='receipt-provenance-v1'` 且
   `provenance.independentReceipt.policy='persisted-device-receipt-v1'`、
   `source='device_receipt'`，且时间戳与执行事实一致、执行/分配/方案/任务/设备 ID 齐备。

因此**人工上报与模拟回执永不参与生产训练**，即使行级标记被写成 `true`。

```sh
GET /api/scheduler/predictions/task-duration/samples
```

返回 `flaggedEligible`（通过行级标记）与 `trainable`（实际可训练）两个数。
**二者不等是正常的**：差额就是"有标记但缺设备证据"。界面必须把差额和原因讲清楚，
否则用户会看到"有样本却训不了"而无从判断。资格判定与训练加载共用同一纯函数
（`training-sample-eligibility.ts`），避免"界面说可训练 N 条、训练报样本不足"的两套口径。

```sh
POST /api/scheduler/predictions/task-duration/retrain
```

样本不足 → `400 retrain_not_enough_data: <reason>`，**不落版、不伪造模型**。
成功时返回 `version/n/medianMs/p90Ms` 以及 `lineage`（来自哪张表、什么资格策略、
本次可训练样本数、按任务类型的分组结果）。

### 5.2 提案状态机与人审阶梯

状态：`proposed → shadow_evaluated → approved | rejected → rolled_back`。
服务端强制该顺序——直接 `proposed → approved` 会被拒（ADR-026）。
`approve/reject/rollback` 仅 `workshop_lead` / `global_admin` 可用；
`propose/shadow` 对任意认证用户开放（反馈腿全角色可提案，激活必经人审）。

影子评估的证据**只能由服务端从库内事实重建**（R2-SBZ-004）：没有可重建的事实窗口时
返回 `400 shadow_facts_window_empty` 并保持 `proposed`。这是**正常业务状态**而非用户错误，
界面需据此说明"证据不可由客户端提供、提案保持待影子评估"。

### 5.3 提案人归属与生成人回避（B5 同族治理，standalone_073）

策略阈值提案此前存在**结构性自批**：台账只有 `approved_by`，没有提议人字段，
于是"提案人不得审批自己的提案"这条回避规则无从执行——同一人提议 + 同一人批准
在形式上满足人审阶梯，实质上等于自批（与方案审批的 B5 治理同族）。

现在：

- `propose` 的提议人取**服务端会话**（`userContext.userId`，请求体里的
  `proposedBy` 被忽略——已用真实后端验证：伪造字段不生效）；
- `approve` 在**任何写入之前**拒绝同一身份自批：
  `403 SELF_APPROVAL_FORBIDDEN: proposal <id> was proposed by the requesting operator (B5 审批独立性)`；
- DB 层 `chk_ewoh_learning_proposal_generator_avoidance` 兜底同一不变量
  （迁移 verify 用"自批写入必被拒 + 跨人审批可写"双探测自证，不只是查字典）；
- `proposed_by IS NULL` 的**存量行放行**，避免历史提案被永久锁死（与方案侧同口径）。

界面据此把"批准"按钮对本人提案禁用并说明原因；**拒绝仍可用**——拒绝自己的提案
等于撤回，服务端允许，界面不得凭空收紧。

### 5.4 阈值基线读面：不猜基线

```sh
GET /api/learning/thresholds      # 需要认证；只读，不激活任何东西
```

返回每个可提案参数的**当前生效值 + 来源 + 读取时间 + 在途/历史提案计数**：

- `source=engine_default` → 生效值是**引擎内置常量**（`engineDefault`），
  界面必须说明"未经人审激活，不是已生效策略"，绝不冒充已激活的策略；
- `source=approved_proposal` → `provenance` 给出提案编号、提议人、审批人、
  批准时间与影子证据来源（`server:ewoh_telemetry`）；
- `source=engine_default_unknown` 且 `effective=null` → 该参数没有登记内置常量，
  界面显示"未知"并**禁止提案**（没有比较基线就不该造候选值）。

学习控制台的「阈值基线与受控变更」面板即消费该读面：先看到真实基线，
再提交候选值（0–1 且必须与生效值不同，no-op 会被契约拒绝），
提交后如实显示"已影子评估/待影子评估"与"不会自动生效"。

### 5.5 完整学习闭环的真实后端验证

```sh
make e2e-learning      # 或 cd ewoh-spark-app && npm run e2e:learning
```

用**模拟外骨骼帧 → 真实摄入 API → 设备↔人员身份映射 → ewoh_telemetry →
服务端影子重放 → 提案 → 自批被拒 → 他人审批激活 → 基线溯源 → 回滚复原**
这条真实数据路径验证整段闭环（27 项断言）。两个环境事实值得先知道：

- 帧数据的**人员归属**来自 `edge-device` 身份映射（`POST /api/identity/mappings`）。
  没有映射时 `telemetry.entity_id` 为 NULL，影子评估会（正确地）跳过该行——
  这不是 bug，而是"设备数据归到谁头上"必须显式登记；
- 脚本会用 `EWOH_E2E_OWNER_DATABASE_URL` 登记两台 `source_type='simulated'` 的
  模拟空间实体（孪生体登记；帧数据仍只走真实摄入通道），未提供该连接串时
  如实报 SKIP（未验证 ≠ 通过）。

### 5.6 缺失不得伪装

- 缺 outcome 标注时 `modelAccuracy=null`，界面显示**"未标注"**，不显示 0% 或 100%；
- 样本不足时显示原因与门槛，不给出看似正常的空图表；
- 提案不会自动生效，人审边界在页面上明示。

## 6. 分波次派工（部分执行）

`POST /api/scheduler/plans/:planId/dispatch` 支持可选 body `{ assignmentIds: [...] }`：

- **省略** → 派发全部待派工 assignment（原有行为，向后兼容）；
- **提供** → 只派发这一波（部分执行）。

语义（借 Timefold 的 pinning 思想：已派工 = 已确认发布，重排不得移动；本仓库既有
`frozenTaskIds` / `LOCKED_TASK_STATUSES` 承载该语义）：

1. **波内全有或全无**：波内任一 assignment 不满足前置条件即拒绝整波
   （`409 DISPATCH_WAVE_INVALID` 并列出问题项），绝不半应用；
2. **计划状态不得伪装**：只有本波覆盖全部待派工 assignment 时才进入契约终态
   `dispatched`（其含义是"全部转任务"）；否则保持 `approved`，并通过响应的
   `dispatch.remainingAssignmentIds` 显式暴露剩余。把部分派工写成 `dispatched`
   会让半成品方案看起来已终结；
3. 已提交的波不因后续波失败而回滚；剩余仍可继续派。

**波次感知的快照新鲜度**：派工自身会改任务状态并写入预占，若仍用"世界与快照完全
相等"的严格判定，第二波必然 `PLAN_STALE`（实测定位）。因此派工路径改用
`assertFreshForWave`：比较时剔除**本方案自身已提交的效果**（本方案已派工任务的
`task:<id>` 版本键、本方案创建的预占及其 `reservation:<type>:<id>` 版本键）。
外部变化（他人改任务、新增外部预占、安全事件）仍会导致不一致 → 拒绝。
这不是放宽安全门：安全阻断、工位容量、任务可派发性、预占冲突都在派工路径事务内外
各自实时复核。

## 7. 分波派工的界面操作（班组长视角）

界面入口：**排产调度**页（`/scheduling`）的「已审批」方案卡片内 → 「分波派工（部分执行）」面板。
仅有 `global_admin` / `dispatcher` / `workshop_lead` 可见（与服务端路由角色一致）。

操作与后果表达（依据"摩擦与破坏半径匹配、批量必须声明条数"的通行准则）：

1. 勾选要派发的任务（默认**不预选**；已提交的项标出"已提交，不可再派"并禁止勾选，
   而不是隐藏——隐藏会让用户以为任务消失了）；
2. 按钮显示"派发选中的 N 条"；未选择时按钮禁用并提示"请选择要派发的任务"，
   不出现"确定/OK"式无语义按钮；
3. 点击后在确认对话框中**写明确切后果**：
   - 部分波 → "本波派发 N 条，派发后仍有 M 条待派工，方案保持'已审批'（未进入终态），
     可继续分波派发"；
   - 覆盖全部剩余 → "本波将派完全部 N 条，方案随即进入终态'已派发'，之后不能再追加波次"；
   - 两者都声明：派工会占用人员/设备/工位并写入预约，**当前没有取消派工的接口**。
4. 派发后显示本波结果：`本波已派发 N 条 · 剩余 M 条待派发（方案仍为已审批，可继续分波派发）`；
5. 服务端**整波拒绝**时显示"本波被整体拒绝（未产生任何派发）"并附服务端业务原因
   （如 `DISPATCH_WAVE_INVALID` 指出的问题项），同时刷新可派工范围。

## 8. 浏览器 × 真实后端的 UI 闭环

mock 浏览器用例验证的是交互与后果表达，HTTP 脚本验证的是服务端语义；两者都不证明
"界面点下去真的驱动了真实后端并落到真实库"。为此提供**真实后端模式**的浏览器用例：

```sh
EWOH_E2E_OWNER_DATABASE_URL=postgresql://ewoh_owner:...@127.0.0.1:55432/ewoh \
EWOH_E2E_RUNTIME_DATABASE_URL=postgresql://ewoh_api:...@127.0.0.1:55432/ewoh \
  make browser-real
```

- runtime 连接串必须是**非超级用户且无 BYPASSRLS**（门禁会显式校验，确保 RLS 真的生效）；
- 全局装置会构建并启动一个独立的后端实例（默认 `127.0.0.1:3106`），**不复用**你手工启动的
  服务；每个用例创建独立租户，运行结束回收（`cleanupE2EFixture`）；
- 覆盖三条 UI 闭环，并在界面上操作后用 API 复核服务端事实（避免"界面说部分、库内已整单"）：
  1. `scheduling-wave-real.e2e.spec.ts`：分波派工 UI → 方案保持 approved / 仅 1 条 dispatched → 收口终态；
  2. `field-receipt-real.e2e.spec.ts`：现场账号（绑定业务人员）在界面报告开始/完成 →
     执行记录 COMPLETED、可训练样本为 0（人工/模拟回执不入训练集）；未绑定账号不推断任务；
  3. `learning-console-real.e2e.spec.ts`：写入模拟遥测（`source_type='simulated'`）后，
     新租户基线 = 引擎常量 → 界面提交候选 → 提案卡显示提议人且"批准"被 B5 生成人回避禁用
     → 另一身份审批 → 刷新见覆盖溯源 → 回滚复原（服务端全程可复核）。

两个模式的**入口不要混用**：mock 模式跑的是 `EWOH_BROWSER_MODE=mock npm run e2e:check`
（UX-009 集合，多视口项目，无需后端）；而 `test/browser/` 整目录还包含
`auth-real-login` / `comprehensive-platform` / `usability-smoke` 等**必须真实后端**的用例
（另有 `scheduler-command-map.e2e.spec.ts`，见其文件头说明）——在 mock 模式下整目录跑
会因缺少后端/凭据而失败，这是预期，不是回归。

会话注入必须写 **sessionStorage**（应用把 access token 与展示身份收敛在 sessionStorage）。

## 9. 已知限制

- 限流：登录默认 10 次 / 15 分钟，全局读接口默认 300 次 / 60 秒
  （`LOGIN_RATE_LIMIT_*` / `RATE_LIMIT_*`）。反复运行场景会被 429；本地验证可
  临时提高上限（脚本对限流如实报 SKIP 并给出处置方式，不会把 429 当成"没有数据"）。
  生产环境不应放宽。
- 本场景不证明物理执行：回执时间取点击时刻，`production_training_eligible`
  对模拟/人工回执恒为 `false`。
- 浏览器侧现场页、学习控制台与分波派工验收使用 mock 数据层
  （`test/browser/field-operations.spec.js`、`test/browser/learning-console.spec.js`、
  `test/browser/scheduling-wave-dispatch.spec.js`），验证的是安全与可信度行为。
  三条主链都另有**真实后端 UI 闭环**：现场回执（`field-receipt-real.e2e.spec.ts`）、
  分波派工（`scheduling-wave-real.e2e.spec.ts`）、学习控制台
  （`learning-console-real.e2e.spec.ts`，覆盖基线→提案→自批回避→他人审批→
  基线溯源→回滚）。`npm run test:browser:real` 一次跑完三者。
- 学习段的影子评估**已可在本地走通**：通过真实摄入 API 写入
  `source_type='simulated'` 的模拟外骨骼帧，并登记 `edge-device → person`
  身份映射（否则 `telemetry.entity_id` 为 NULL，影子评估会跳过该行——这是
  归属未登记，不是数据缺失）。seed 场景本身仍没有事实窗口，直接对 seed 提案
  仍会得到 `shadow_facts_window_empty` 并保持 `proposed`（设计边界，fail-closed）。
  时长模型同理：演示数据全部为人工/模拟回执，`trainable=0`，重训会如实报样本不足。
- 真实设备、真实产线与外部系统未参与；相关适配与降级见
  [九层目标架构](../architecture/embodied_factory.md) 与
  [2026-09 主产品交付与权威边界](../architecture/product-delivery-2026-09.md)。
