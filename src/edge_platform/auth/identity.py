"""身份认证后端（Task 27）。

提供统一身份认证抽象与离线实现：
- ``User``：已认证用户的数据载体。
- ``IdentityBackend``：认证后端抽象基类，子类实现 ``authenticate``。
- ``OfflineIdentityBackend``：本地内存用户表（预置 admin/safety_officer/operator
  三个账号）。EDGE-007（2026-08-17 审计整改）：密码校验由快速哈希
  sha256(salt+password) 升级为 ``hashlib.pbkdf2_hmac("sha256", ..., 200k迭代)``
  （运行时零第三方依赖，bcrypt/argon2 不可引入；PBKDF2 为审计认可的等价强化），
  用 ``secrets.compare_digest`` 做常量时间比较。
  D14（2026-08-19 审计）：种子口令硬编码默认值（admin123 等）此前在 production
  模式照常生效——现强制经环境变量置换（EWOH_SEED_ADMIN_PASSWORD 等）：
  production 未配置或仍等于公开默认值 → 构造即拒绝（RuntimeError）；
  development/simulation 保留试点文档默认口令（演示口径不变）。
- ``OIDCIdentityBackend``：OIDC 后端 stub（仅留接口，未实现完整 OIDC 流程）。
- ``get_identity_backend``：依据 ``Settings.auth_backend`` 选择后端。

纯 Python 标准库实现，零第三方依赖。
"""

import hashlib
import os
import secrets
import threading
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional

from edge_platform.config import Settings

# EDGE-007：PBKDF2-HMAC-SHA256 迭代次数（OWASP 2023 对该组合的推荐量级 ≥600k；
# 边缘设备 CPU 预算与测试时长折中取 200k，且显著慢于原快速 sha256）。
_PBKDF2_ITERATIONS = 200_000
_SALT_BYTES = 16


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

    预置三个账号：admin / safety_officer / operator，密码使用 PBKDF2-HMAC-SHA256
    （salt 随机 + 200k 迭代）校验。种子账号的 salt+hash 在进程内只派生一次并缓存
    （派生成本约百毫秒级；SessionManager.login 每次构造本类时复用缓存）。
    """

    # 预置账号（user_id, username, role, display_name, 环境变量名, 开发默认密码）
    _SEED_ACCOUNTS = (
        ("U-ADMIN", "admin", "admin", "管理员", "EWOH_SEED_ADMIN_PASSWORD", "admin123"),
        ("U-SAFETY", "safety_officer", "safety_officer", "安全官", "EWOH_SEED_SAFETY_PASSWORD", "safety123"),
        ("U-OP", "operator", "operator", "操作员", "EWOH_SEED_OPERATOR_PASSWORD", "operator123"),
    )

    # 进程级种子校验缓存：username -> {"user_id","role","display_name","salt","hash"}
    _seed_verifiers: Optional[dict] = None
    _seed_verifiers_lock = threading.Lock()

    def __init__(self, settings: Optional[Settings] = None):
        settings = settings or Settings.load()
        self._users: dict = {}
        for username, entry in self._seed_verifiers_map(settings).items():
            self._users[username] = dict(entry)

    @classmethod
    def _resolve_seed_passwords(cls, settings: Settings) -> dict:
        """种子口令解析（审计 D14，2026-08-19）。

        - production：强制环境变量（EWOH_SEED_*_PASSWORD）——未配置或仍等于
          公开默认值 → RuntimeError（拒绝启动，硬编码凭据不得在生产生效）；
        - development / simulation：环境变量优先，未配置回退试点文档默认口令。

        环境变量以字面量逐项读取（audit-env-inventory 静态识别要求，非变量间接）。
        """
        production = settings.runtime_mode == "production"
        env_values = {
            "admin": (os.environ.get("EWOH_SEED_ADMIN_PASSWORD") or "").strip(),
            "safety_officer": (os.environ.get("EWOH_SEED_SAFETY_PASSWORD") or "").strip(),
            "operator": (os.environ.get("EWOH_SEED_OPERATOR_PASSWORD") or "").strip(),
        }
        passwords: dict = {}
        for _user_id, username, _role, _display, env_name, default in cls._SEED_ACCOUNTS:
            value = env_values[username]
            if production:
                if not value:
                    raise RuntimeError(
                        f"production 模式离线身份后端要求 {env_name} 显式配置种子口令"
                        f"（硬编码默认口令禁止在生产生效；审计 D14）"
                    )
                if value == default:
                    raise RuntimeError(
                        f"{env_name} 仍等于公开默认口令，拒绝启动（须置换后部署；审计 D14）"
                    )
            else:
                value = value or default
            passwords[username] = value
        return passwords

    @classmethod
    def _seed_verifiers_map(cls, settings: Optional[Settings] = None) -> dict:
        """惰性派生并缓存种子账号校验器（每进程一次）。"""
        if cls._seed_verifiers is None:
            with cls._seed_verifiers_lock:
                if cls._seed_verifiers is None:
                    resolved = settings or Settings.load()
                    passwords = cls._resolve_seed_passwords(resolved)
                    verifiers = {}
                    for user_id, username, role, display_name, _env_name, _default in cls._SEED_ACCOUNTS:
                        salt = secrets.token_hex(_SALT_BYTES)
                        verifiers[username] = {
                            "user_id": user_id,
                            "role": role,
                            "display_name": display_name,
                            "salt": salt,
                            "hash": cls._hash(salt, passwords[username]),
                        }
                    cls._seed_verifiers = verifiers
        return cls._seed_verifiers

    @staticmethod
    def _hash(salt: str, password: str) -> str:
        """PBKDF2-HMAC-SHA256(salt, password, 200k) 十六进制摘要。"""
        digest = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt.encode("utf-8"), _PBKDF2_ITERATIONS
        )
        return digest.hex()

    def add_user(self, user_id, username, role, display_name, password):
        """注册一个新用户到内存表（演示/测试用途）。"""
        salt = secrets.token_hex(_SALT_BYTES)
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
        # D14：production 未配置种子口令环境变量 → 构造抛 RuntimeError（拒绝启动）。
        return OfflineIdentityBackend(settings)
    if backend == "oidc":
        return OIDCIdentityBackend(settings)
    raise ValueError(f"未知的身份认证后端: {backend!r}")
