"""身份认证后端（Task 27）。

提供统一身份认证抽象与离线实现：
- ``User``：已认证用户的数据载体。
- ``IdentityBackend``：认证后端抽象基类，子类实现 ``authenticate``。
- ``OfflineIdentityBackend``：本地内存用户表（预置 admin/safety_officer/operator
  三个账号），密码使用 ``hashlib.sha256`` 加 salt 校验，用
  ``secrets.compare_digest`` 做常量时间比较。
- ``OIDCIdentityBackend``：OIDC 后端 stub（仅留接口，未实现完整 OIDC 流程）。
- ``get_identity_backend``：依据 ``Settings.auth_backend`` 选择后端。

纯 Python 标准库实现，零第三方依赖。
"""

import hashlib
import secrets
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional

from edge_platform.config import Settings


@dataclass
class User:
    """已认证用户。"""

    user_id: str
    username: str
    role: str
    display_name: str


class IdentityBackend(ABC):
    """身份认证后端抽象基类。"""

    @abstractmethod
    def authenticate(self, username: str, password: str) -> Optional[User]:
        """校验用户名/密码，成功返回 User，失败返回 None。"""


class OfflineIdentityBackend(IdentityBackend):
    """离线（本地内存）身份后端。

    预置三个账号：admin / safety_officer / operator，密码使用 sha256+salt 校验。
    每个账号的 salt 在构造时随机生成（演示用途，不持久化）。
    """

    # 预置账号（user_id, username, role, display_name, 默认密码）
    _SEED_ACCOUNTS = (
        ("U-ADMIN", "admin", "admin", "管理员", "admin123"),
        ("U-SAFETY", "safety_officer", "safety_officer", "安全官", "safety123"),
        ("U-OP", "operator", "operator", "操作员", "operator123"),
    )

    def __init__(self):
        # username -> {"user_id", "role", "display_name", "salt", "hash"}
        self._users: dict = {}
        for user_id, username, role, display_name, password in self._SEED_ACCOUNTS:
            salt = secrets.token_hex(8)
            self._users[username] = {
                "user_id": user_id,
                "role": role,
                "display_name": display_name,
                "salt": salt,
                "hash": self._hash(salt, password),
            }

    @staticmethod
    def _hash(salt: str, password: str) -> str:
        """sha256(salt + password) 十六进制摘要。"""
        return hashlib.sha256((salt + password).encode("utf-8")).hexdigest()

    def add_user(self, user_id, username, role, display_name, password):
        """注册一个新用户到内存表（演示/测试用途）。"""
        salt = secrets.token_hex(8)
        self._users[username] = {
            "user_id": user_id,
            "role": role,
            "display_name": display_name,
            "salt": salt,
            "hash": self._hash(salt, password),
        }

    def authenticate(self, username: str, password: str) -> Optional[User]:
        entry = self._users.get(username)
        if entry is None:
            return None
        computed = self._hash(entry["salt"], password)
        if not secrets.compare_digest(computed, entry["hash"]):
            return None
        return User(
            user_id=entry["user_id"],
            username=username,
            role=entry["role"],
            display_name=entry["display_name"],
        )


class OIDCIdentityBackend(IdentityBackend):
    """OIDC 身份后端 stub。

    仅保留接口契约，未实现完整 OIDC 授权码/PKCE 流程；
    authenticate 恒返回 None，表示需要外部 IdP 完成认证后再注入 User。
    """

    def __init__(self, settings: Optional[Settings] = None):
        self.settings = settings or Settings.load()

    def authenticate(self, username: str, password: str) -> Optional[User]:
        # stub：未实现，需由外部 IdP 完成认证
        return None


def get_identity_backend(settings: Optional[Settings] = None) -> IdentityBackend:
    """依据 Settings.auth_backend 选择身份后端。

    - ``offline``（默认）：OfflineIdentityBackend
    - ``oidc``：OIDCIdentityBackend（stub）
    - 其他值抛 ValueError。
    """
    settings = settings or Settings.load()
    backend = settings.auth_backend
    if backend == "offline":
        return OfflineIdentityBackend()
    if backend == "oidc":
        return OIDCIdentityBackend(settings)
    raise ValueError(f"未知的身份认证后端: {backend!r}")
