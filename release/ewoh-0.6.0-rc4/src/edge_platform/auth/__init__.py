"""身份认证与会话管理（Task 27）。

- identity：身份后端抽象、离线实现、OIDC stub。
- session：会话管理器与登录失败锁定。

纯 Python 标准库实现，零第三方依赖。
"""

from edge_platform.auth.identity import (
    IdentityBackend,
    OfflineIdentityBackend,
    OIDCIdentityBackend,
    User,
    get_identity_backend,
)
from edge_platform.auth.session import Session, SessionManager

__all__ = [
    "User",
    "IdentityBackend",
    "OfflineIdentityBackend",
    "OIDCIdentityBackend",
    "get_identity_backend",
    "Session",
    "SessionManager",
]
