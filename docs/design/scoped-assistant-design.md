# scoped-assistant 原型设计

**文档版本**: 1.0
**创建日期**: 2026-08-24
**状态**: Draft

## 1. 概述

`scoped-assistant` 是 EWOH 的 LLM 辅助调度约束配置能力。当前状态为 Prototype（边缘 `assistant.local_llm` 白名单问答），目标是扩展为云侧 LLM 辅助调度配置生成。

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

```typescript
// 提示注入防护
const SAFE_INPUT_PATTERN = /^[a-zA-Z0-9\u4e00-\u9fa5\s,.\-:;()（）]+$/;
if (!SAFE_INPUT_PATTERN.test(userInput)) {
  throw new BadRequestException('输入包含不安全字符');
}
```

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

## 5. 评估指标

| 指标 | 目标 | 说明 |
|------|------|------|
| 配置生成准确率 | ≥80% | LLM 生成的配置通过校验的比例 |
| 用户接受率 | ≥70% | 用户确认（不修改）的比例 |
| 时间节省 | ≥50% | 相比手写配置的时间减少 |
| 安全事件 | 0 | 提示注入/数据泄露事件数 |

## 6. 原型实现计划

### 6.1 MVP 范围

- 支持调度约束配置生成（仅 heuristic solver）
- 支持 3 种约束类型：时间窗口、资源限制、优先级
- 单租户测试环境

### 6.2 技术栈

- **LLM**：OpenAI GPT-4 或开源 Llama 3
- **后端**：NestJS（复用现有 `ai` 模块）
- **前端**：React（复用现有 UI 组件）
- **校验**：Zod（复用现有 schema）

### 6.3 开发步骤

1. 定义 LLM 提示模板（系统提示 + 用户输入）
2. 实现 `/api/assistant/generate-config` 端点
3. 集成现有校验逻辑
4. 实现审计日志记录
5. 前端 UI 集成
6. 安全测试（提示注入、数据泄露）
7. 内部评测

## 7. 文件清单

| 文件 | 说明 |
|------|------|
| `src/edge_platform/assistant/local_llm.py` | 边缘 LLM（现有） |
| `ewoh-spark-app/server/modules/ai/` | 云侧 AI 模块（现有） |
| `docs/design/scoped-assistant-design.md` | 本文档 |
