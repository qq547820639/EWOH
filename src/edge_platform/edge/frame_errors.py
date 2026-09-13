"""边缘帧契约错误（唯一类型，供存储层与归一化层共用）。

放在独立模块的理由：`edge/storage.py`（持久层）需要抛同一类型，但不该反向
依赖 `edge/modeling/*`（归一化层）。两处共用同一异常类型，调用方
（`AdapterManager`）才能用 `except FrameContractError` 统一转死信。
"""

from __future__ import annotations


class FrameContractError(ValueError):
    """帧不满足归一化/持久化契约（缺身份字段 / 未登记类别）。

    调用方必须把它转成**死信记录 + 计数 + ERROR 日志**，绝不允许静默丢弃：
    现场丢的是数据，平台丢的是事实。
    """

    def __init__(self, kind: str | None, reason: str, missing: tuple[str, ...] = ()) -> None:
        self.kind = kind
        self.reason = reason
        self.missing = tuple(missing)
        detail = f"（kind={kind or 'unknown'}"
        if self.missing:
            detail += f", missing={list(self.missing)}"
        detail += "）"
        super().__init__(f"{reason}{detail}")


__all__ = ["FrameContractError"]
