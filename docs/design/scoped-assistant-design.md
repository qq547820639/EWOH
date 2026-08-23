# scoped-assistant 原型设计

**文档版本**: 1.0
**创建日期**: 2026-08-24
**状态**: Draft

## 1. 概述

`scoped-assistant` 是 EWOH 的 LLM 辅助调度约束配置能力。当前状态为 Prototype（边缘 `assistant.local_llm` 白名单问答），目标是扩展为云侧 LLM 辅助调度配置生成。

### 1.1 现有 AI 模块说明

`server/modules/ai/` 当前功能：
- **AiService**：基于遥测数据生成 AI 建议（`AiSuggestion`），使用 `ArkService` 调用 LLM
- **ArkService**：LLM 调用封装（HTTP API 调用外部 LLM 服务）
- **功能边界**：仅生成建议文本，不直接修改生产配置

新功能 `scoped-assistant` 将**扩展** `ai` 模块，新增：
- 调度约束配置生成端点（`/api/assistant/generate-config`）
- 结构化输出解析（JSON Schema 校验）
- 审计日志记录

## 2. 功能边界

### 2.1 允许范围

- 生成调度约束配置草稿（JSON/YAML）
- 解释现有约束配置
- 建议约束参数调整
- 生成调度策略模板

### 2.2 禁止范围

- 直接修改生产配置
- 直接执行调度
- 直接访问租户敏感数据
- 绕过人工确认流程

## 3. 交互流程

```
┌─────────┐    自然语言    ┌─────────┐    结构化配置    ┌─────────┐
│  用户   │ ──────────→  │   LLM   │ ──────────→  │  系统   │
│         │              │         │              │         │
│ 输入需求 │              │ 生成草稿 │              │ 校验解析 │
└─────────┘              └─────────┘              └─────────┘
     ↑                                                │
     │              确认/修改                           │
     └────────────────────────────────────────────────┘
```

### 3.1 详细步骤

1. **用户输入**：自然语言描述调度需求（如"每天早上 8 点分配生产线任务"）
2. **LLM 生成**：输出结构化配置草稿（JSON）
3. **系统校验**：复用现有校验逻辑（`scheduler-config.service.ts`）
4. **展示确认**：UI 展示配置草稿 + 校验结果
5. **用户确认**：用户确认/修改后写入系统
6. **审计记录**：记录 LLM 请求/响应/用户确认

## 4. 安全措施

### 4.1 输入过滤

采用**黑名单模式**（过滤已知危险字符），而非白名单（会误拒合法配置描述）：

```typescript
// 提示注入防护：黑名单模式
const BLOCKED_PATTERNS = [
  /ignore\s+(previous|all|above)\s+instructions/i,  // 经典注入
  /system\s*:\s*/i,                                  // 伪装系统提示
  /\{\{.*\}\}/,                                      // 模板注入
  /<script/i,                                        // XSS
  /```[\s\S]*```/,                                   // 代码块注入（可选，取决于场景）
];

function validateInput(input: string): void {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(input)) {
      throw new BadRequestException('输入包含不安全内容');
    }
  }
  if (input.length > 2000) {
    throw new BadRequestException('输入过长（最大 2000 字符）');
  }
}
```

**说明**：允许 `#`、`/`、`=`、`{`、`}` 等字符，因为描述约束配置时常用（如"权重=0.8"、"CRITICAL/MAJOR"）。

### 4.2 输出沙箱

```typescript
// LLM 输出必须通过 JSON Schema 校验
const configSchema = z.object({
  solverVersion: z.enum(['heuristic', 'rule-based-v1', 'milp-v1']),
  constraints: z.array(constraintSchema),
  // ...
});
const parsed = configSchema.parse(llmOutput);
```

### 4.3 敏感数据脱敏

- LLM 仅接触脱敏数据（无真实人员姓名、设备 ID）
- 使用占位符（如 `{worker_1}`, `{machine_1}`）
- 响应中敏感字段自动脱敏

### 4.4 审计日志

```typescript
interface AssistantAuditEntry {
  requestId: string;
  userId: string;
  orgId: string;
  userInput: string;
  llmResponse: string;
  parsedConfig: unknown;
  userConfirmed: boolean;
  timestamp: Date;
}
```

## 5. 失败模式与降级策略

### 5.1 LLM 生成配置无法通过校验

**场景**：LLM 输出的 JSON 无法通过 Zod schema 校验（字段缺失、类型错误、值越界）。

**处理**：
1. 将校验错误信息反馈给 LLM，请求修正（最多重试 2 次）
2. 若 2 次重试后仍失败，返回错误信息给用户，展示校验错误详情
3. 不自动降级为手写配置（避免静默失败）

### 5.2 LLM 超时

**场景**：LLM 调用超过 30s 未响应。

**处理**：
1. 返回超时错误给用户
2. 建议用户手写配置或稍后重试
3. 记录审计日志（超时事件）

### 5.3 LLM 返回有害内容

**场景**：LLM 输出包含注入攻击或有害指令。

**处理**：
1. 输出沙箱（Zod 校验）拦截非结构化内容
2. 若输出包含可执行代码片段，拒绝并记录安全事件
3. 告警通知管理员

### 5.4 降级策略

| 故障 | 降级动作 |
|------|----------|
| LLM 不可用 | 禁用 assistant 功能，提示用户手写配置 |
| LLM 响应慢 (>30s) | 超时后提示用户手写配置 |
| 校验失败 (3次) | 提示用户手写配置，记录日志 |
| 安全事件 | 禁用 assistant 功能，告警管理员 |

## 6. 评估指标

### 6.1 指标定义

| 指标 | 目标 | 测量方法 |
|------|------|----------|
| 配置生成准确率 | ≥80% | 标注数据集：50 条用户需求 → 期望配置，LLM 生成后通过 Zod 校验 + 人工审核 |
| 用户接受率 | ≥70% | 前端埋点：用户点击"确认"vs"修改"的比例 |
| 时间节省 | ≥50% | A/B 测试：同一需求，LLM 辅助 vs 手写，记录完成时间 |
| 安全事件 | 0 | 审计日志：提示注入/数据泄露事件数 |

### 6.2 标注数据集构建

- 收集 50 条典型调度需求（覆盖 3 种约束类型：时间窗口、资源限制、优先级）
- 人工编写期望配置（JSON）
- 作为 LLM 生成准确率的评估基准

### 6.3 前端埋点

```typescript
// 用户操作埋点
interface AssistantMetric {
  requestId: string;
  action: 'confirm' | 'modify' | 'cancel';
  timeToDecisionMs: number;  // 从展示到用户操作的时间
  modificationCount: number; // 用户修改了几个字段
}
```

## 7. 原型实现计划

### 7.1 MVP 范围

- 支持调度约束配置生成（仅 heuristic solver）
- 支持 3 种约束类型：时间窗口、资源限制、优先级
- 单租户测试环境

### 7.2 技术栈

- **LLM**：OpenAI GPT-4 或开源 Llama 3
- **后端**：NestJS（复用现有 `ai` 模块）
- **前端**：React（复用现有 UI 组件）
- **校验**：Zod（复用现有 schema）

### 7.3 开发步骤

1. 定义 LLM 提示模板（系统提示 + 用户输入）
2. 实现 `/api/assistant/generate-config` 端点
3. 集成现有校验逻辑
4. 实现审计日志记录
5. 前端 UI 集成
6. 安全测试（提示注入、数据泄露）
7. 内部评测

## 8. 文件清单

| 文件 | 说明 |
|------|------|
| `src/edge_platform/assistant/local_llm.py` | 边缘 LLM（现有） |
| `ewoh-spark-app/server/modules/ai/` | 云侧 AI 模块（现有） |
| `docs/design/scoped-assistant-design.md` | 本文档 |
