"""统一审计日志（Task 29）。

- logger：``AuditLogger`` 包装 Storage 审计日志读写，统一业务层入口。

纯 Python 标准库实现，零第三方依赖。
"""

from edge_platform.audit.logger import AuditLogger

__all__ = ["AuditLogger"]
