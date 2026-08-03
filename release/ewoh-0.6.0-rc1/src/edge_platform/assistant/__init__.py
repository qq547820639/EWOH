"""本地大模型助手模块（spec Task 27）：自然语言查询/事件总结/调度方案解释/规则检索/
历史案例/交接班摘要/异常根因假设/报告生成。

对应 spec「本地大模型角色约束」：大模型不直接实时控制，不取代调度优化器，
不虚构传感器数据或调度结果；调度结果来自结构化算法，大模型仅负责解释。

默认使用内置 TemplateBackend（基于规则模板，不调用大模型 API）；
未来接入真实 LLM 时，可将 LocalLLMAssistant(llm_backend=...) 替换为真实 backend。

纯 Python 标准库实现。
"""

from .local_llm import (
    LLMIntent,
    LLMResponse,
    LocalLLMAssistant,
    TemplateBackend,
)

__all__ = [
    "LLMIntent",
    "LLMResponse",
    "LocalLLMAssistant",
    "TemplateBackend",
]
