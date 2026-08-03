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
  };
}
