"""网络安全中间件与工具（Task 30）。

提供三项纯标准库能力，供 ``server.py`` 在 HTTP 层复用：

- ``SecurityHeaders``：响应安全头中间件。在响应头中追加
  ``X-Content-Type-Options: nosniff``、``X-Frame-Options: DENY``、
  ``Cache-Control: no-store``，防范 MIME 嗅探、点击劫持与敏感响应缓存。
  既可手动 ``apply(handler)`` 单次注入，也可 ``wrap(handler_cls)`` 包装整个
  handler 类（在 ``end_headers`` 前统一注入）。
- ``rate_limiter(max_per_minute=60)``：内存速率限制器（按 IP），超限返回 429。
  返回一个装饰器，包装 handler 类的 ``do_GET``/``do_POST``，在窗口内同一 IP
  请求超过上限时直接返回 ``429 Too Many Requests``，并带 ``Retry-After`` 头。
- ``validate_input(data, schema)``：简单输入校验（字段必填/类型/最大长度），
  并对字符串字段做基础注入模式检测（SQL 关键字 / 脚本标签），返回
  ``(ok, errors)``。

设计原则：
- 纯 Python 标准库（``time`` / ``collections.deque``），零第三方依赖。
- 不修改既有 handler 的请求处理逻辑，仅在响应头与请求入口做横切增强。
- 速率限制器为进程内内存实现，适用于单机边缘部署；不持久化、不跨进程。
"""

import time
from collections import deque
from typing import Callable


# ---- 安全响应头 ----
class SecurityHeaders:
    """HTTP 安全响应头中间件。

    三项固定头部（与 spec 安全基线一致）：
    - ``X-Content-Type-Options: nosniff``：阻止浏览器 MIME 嗅探。
    - ``X-Frame-Options: DENY``：禁止页面被嵌入 iframe（防点击劫持）。
    - ``Cache-Control: no-store``：禁止缓存敏感响应。

    用法：
    >>> SecurityHeaders.apply(handler)            # 在 end_headers 前手动注入
    >>> HandlerCls = SecurityHeaders.wrap(HandlerCls)  # 包装整个 handler 类
    """

    HEADERS: dict[str, str] = {
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Cache-Control": "no-store",
    }

    @classmethod
    def apply(cls, handler) -> None:
        """在 handler 当前响应上追加安全头（须在 ``end_headers`` 之前调用）。"""
        for name, value in cls.HEADERS.items():
            handler.send_header(name, value)

    @classmethod
    def wrap(cls, handler_cls: type) -> type:
        """包装 handler 类：在 ``end_headers`` 前统一注入安全头。

        保持原有 ``end_headers`` 行为，仅在调用前追加安全头；可安全叠加在
        已有 ``end_headers`` 覆盖之上。返回原 handler 类（就地修改）。
        """
        parent_end_headers = handler_cls.end_headers

        def end_headers(self):
            cls.apply(self)
            parent_end_headers(self)

        handler_cls.end_headers = end_headers  # type: ignore[assignment]
        return handler_cls


# ---- 速率限制器 ----
class _RateLimiter:
    """滑动窗口速率限制器（按 IP，进程内内存）。

    每个 IP 维护一个时间戳队列，每次 ``check`` 清理窗口外过期样本后判断是否
    超限；未超限则记录本次请求时间戳。
    """

    def __init__(self, max_per_minute: int = 60, window_sec: float = 60.0):
        self.max = int(max_per_minute)
        self.window_sec = float(window_sec)
        self._buckets: dict[str, deque] = {}

    def check(self, ip: str) -> bool:
        """返回 True 表示允许通过，False 表示已达上限。"""
        if not ip:
            ip = "unknown"
        now = time.monotonic()
        bucket = self._buckets.get(ip)
        if bucket is None:
            bucket = deque()
            self._buckets[ip] = bucket
        cutoff = now - self.window_sec
        while bucket and bucket[0] < cutoff:
            bucket.popleft()
        if len(bucket) >= self.max:
            return False
        bucket.append(now)
        return True

    def reset(self, ip: str = None) -> None:
        """清除指定 IP（或全部）的计数（测试与运维用途）。"""
        if ip is None:
            self._buckets.clear()
        else:
            self._buckets.pop(ip, None)


def rate_limiter(max_per_minute: int = 60) -> Callable[[type], type]:
    """速率限制中间件装饰器工厂。

    包装 handler 类的 ``do_GET`` / ``do_POST``：在请求入口按客户端 IP 计数，
    超限直接返回 ``429 Too Many Requests``（JSON 错误体 + ``Retry-After`` 头），
    不进入原处理逻辑。其他方法不受影响。

    参数：
        max_per_minute: 每分钟每 IP 最大请求数，默认 60。

    用法：
    >>> Handler = rate_limiter(max_per_minute=120)(Handler)
    """
    rl = _RateLimiter(max_per_minute=max_per_minute)

    def _send_429(handler):
        body = b'{"error":"rate_limit_exceeded"}'
        handler.send_response(429)
        handler.send_header("Content-Type", "application/json; charset=utf-8")
        handler.send_header("Content-Length", str(len(body)))
        handler.send_header("Retry-After", "60")
        handler.send_header("Cache-Control", "no-store")
        handler.end_headers()
        try:
            handler.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _ip(handler):
        return handler.client_address[0] if handler.client_address else "unknown"

    def decorator(handler_cls: type) -> type:
        for method in ("do_GET", "do_POST"):
            parent = getattr(handler_cls, method, None)
            if parent is None:
                continue

            def _wrapped(self, _parent=parent):
                if not rl.check(_ip(self)):
                    return _send_429(self)
                return _parent(self)

            setattr(handler_cls, method, _wrapped)
        # 暴露限流器实例，便于测试与运维 reset
        handler_cls._rate_limiter = rl  # type: ignore[attr-defined]
        return handler_cls

    return decorator


# ---- 输入校验 ----
# 基础注入模式（小写匹配）。仅匹配明显恶意模式，避免误伤正常文本。
_INJECTION_PATTERNS: tuple[str, ...] = (
    "--", "/*", "*/", "xp_",
    "union select", "or 1=1", "and 1=1", "drop table", "delete from",
    "insert into", "update set", "exec(", "execute(",
    "<script", "</script", "javascript:", "onerror=", "onload=",
    "<iframe", "<img onerror", "eval(", "alert(",
)


def _looks_injected(value: str) -> bool:
    low = value.lower()
    return any(p in low for p in _INJECTION_PATTERNS)


def validate_input(data, schema) -> tuple[bool, list[str]]:
    """简单输入校验：字段必填 / 类型 / 最大长度 / 注入检测。

    ``schema`` 形如：
    >>> {
    ...     "username": {"type": str, "required": True, "max_length": 64},
    ...     "age": {"type": int, "required": False},
    ...     "note": {"type": str, "max_length": 200},
    ... }

    规则：
    - ``required``：字段缺失或为空字符串/None → 错误。
    - ``type``：值非空时必须为该类型实例（bool 是 int 的子类，单独排除以免
      ``True`` 被当作 ``int`` 通过）。
    - ``max_length``：仅对 str 生效，超长 → 错误。
    - 字符串字段做基础注入检测，命中模式 → 错误。

    返回 ``(ok, errors)``：``ok`` 为 True 时 ``errors`` 为空列表。
    """
    errors: list[str] = []
    if not isinstance(data, dict):
        return False, ["输入数据必须为字典"]
    for field, rule in (schema or {}).items():
        if not isinstance(rule, dict):
            errors.append(f"{field} 规则格式错误")
            continue
        required = bool(rule.get("required", False))
        present = field in data and data[field] is not None and data[field] != ""
        if not present:
            if required:
                errors.append(f"{field} 必填")
            continue
        value = data[field]
        expected_type = rule.get("type")
        if expected_type is not None:
            # bool 是 int 子类：若期望 int，则拒绝 bool；其它类型正常 isinstance
            if expected_type is int and isinstance(value, bool):
                errors.append(f"{field} 类型错误，期望 int")
                continue
            if not isinstance(value, expected_type):
                errors.append(
                    "{} 类型错误，期望 {}".format(field, getattr(expected_type, "__name__", str(expected_type)))
                )
                continue
        max_length = rule.get("max_length")
        if max_length is not None and isinstance(value, str) and len(value) > max_length:
            errors.append(f"{field} 长度超限（最大 {max_length}）")
            continue
        if isinstance(value, str) and _looks_injected(value):
            errors.append(f"{field} 包含可疑注入内容")
    return (len(errors) == 0), errors


__all__ = ["SecurityHeaders", "rate_limiter", "validate_input"]
