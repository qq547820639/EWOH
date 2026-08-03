# API 文档

本文件为 EWOH 受控试点系统 API 文档骨架。OpenAPI 3.0 规范位于
[`./openapi.yaml`](./openapi.yaml)，本文件描述端点清单与横切要求。

## 规范位置

- OpenAPI 3.0：`docs/api/openapi.yaml`
- JSON Schema（事件/任务/遥测）：`delivery/02_技术规范/schemas/`
- 既有规范参考：`delivery/02_技术规范/openapi.yaml`

## 端点清单

| 方法   | 路径                          | 说明                | 鉴权      | 审计 | 幂等 | 限流           |
|--------|-------------------------------|---------------------|-----------|------|------|----------------|
| POST   | /api/auth/login               | 登录获取令牌        | 无        | 是   | 否   | 严格（防爆破） |
| POST   | /api/auth/refresh             | 刷新访问令牌        | Refresh  | 是   | 否   | 标准           |
| GET    | /api/me                       | 当前用户信息        | Bearer    | 否   | 是   | 标准           |
| GET    | /api/devices                  | 设备列表            | Bearer    | 否   | 是   | 标准           |
| GET    | /api/devices/{id}             | 设备详情            | Bearer    | 否   | 是   | 标准           |
| GET    | /api/devices/{id}/health      | 设备健康            | Bearer    | 否   | 是   | 标准           |
| GET    | /api/telemetry/latest         | 最新遥测            | Bearer    | 否   | 是   | 标准           |
| GET    | /api/telemetry/series         | 遥测时序            | Bearer    | 否   | 是   | 标准           |
| POST   | /api/telemetry/export         | 遥测导出            | Bearer+角色 | 是 | 否   | 严格           |
| GET    | /api/events                   | 事件列表            | Bearer    | 否   | 是   | 标准           |
| GET    | /api/events/{id}              | 事件详情            | Bearer    | 否   | 是   | 标准           |
| POST   | /api/events/{id}/status       | 更新事件状态        | Bearer    | 是   | 是   | 标准           |
| POST   | /api/events/{id}/comment      | 事件评论            | Bearer    | 是   | 否   | 标准           |
| POST   | /api/tasks/recommend          | 任务推荐            | Bearer    | 是   | 否   | 标准           |
| POST   | /api/tasks/confirm            | 任务确认            | Bearer    | 是   | 是   | 标准           |
| GET    | /api/assignments              | 任务分配列表        | Bearer    | 否   | 是   | 标准           |
| POST   | /api/query                    | 综合查询            | Bearer    | 否   | 是   | 标准           |
| GET    | /api/audit                    | 审计日志查询        | Bearer+角色 | 是 | 是   | 严格           |
| GET    | /api/models                   | 模型列表            | Bearer    | 否   | 是   | 标准           |
| GET    | /api/rules                    | 规则列表            | Bearer    | 否   | 是   | 标准           |
| POST   | /api/scenario/evaluate        | 场景评估            | Bearer    | 是   | 否   | 标准           |
| POST   | /api/reset                    | 受控重置（试点）    | Bearer+角色 | 是 | 是   | 严格           |

## 横切要求

- **鉴权**：除 `/api/auth/login` 外，所有端点均需 `BearerAuth`；导出/审计/重置等
  敏感端点需额外角色（见 `delivery/04_安全合规/RBAC_matrix.csv` 与 `EWOH_EXPORT_ALLOWED_ROLES`）。
- **审计**：所有写操作、导出、登录/鉴权事件入审计日志，可在 `GET /api/audit` 查询。
- **幂等**：标注"是"的端点对相同请求参数重复调用不产生副作用；状态/确认类端点
  通过请求标识或状态机保证幂等。
- **限流**：登录、导出、审计、重置等端点采用更严格的限流策略，防止爆破与滥用。
- **安全边界**：API 不下发任何急停/限扭/关节实时控制等设备实时控制指令。
