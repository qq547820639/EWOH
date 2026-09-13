// 错误统一响应
export interface ApiErrorResponse {
  /** 错误详情 */
  error: {
    /** 错误代码 */
    code: string;
    /** 统一错误代码（当前版本的事实字段） */
    errorCode: string;
    /** 错误消息 */
    message: string;
    /** 错误详情 */
    details?: string;
    /** 字段验证错误 */
    fieldErrors?: Record<string, string[]>;
    /** 请求 ID，用于日志/审计/Support Bundle 关联 */
    requestId: string;
    /** 是否可安全重试 */
    retryable: boolean;
    /** 面向操作员的建议动作 */
    recommendedAction: string;
    /** 调用栈（仅开发环境） */
    stack?: string;
    /** 错误原因 */
    cause?: string;
    /** 错误发生时间 */
    timestamp?: number;
    /**
     * NO-62c：结构化诊断（错误也是**可处置的信息**，不能只有一句状态码）。
     *
     * 首个使用方是 `POST /api/scheduler/plans/:id/approve` 的 409 `PLAN_STALE`：
     * 带 `planStaleness`（世界状态差异明细）与 `replanAvailable`。
     * 形状由各域自定（这里只登记约定），客户端按字段名判存，缺失即降级为文案说明。
     */
    planStaleness?: unknown;
    replanAvailable?: boolean;
  };
}
