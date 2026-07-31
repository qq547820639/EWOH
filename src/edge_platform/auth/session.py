"""会话管理（Task 27）。

提供基于内存 dict 的会话管理与登录失败锁定：
- ``Session``：会话数据载体（session_id/user_id/role/created_at/expires_at）。
- ``SessionManager``：创建/校验/撤销会话；``login`` 编排认证 + 会话创建 + 失败锁定。
  - 会话 token：``secrets.token_urlsafe(32)``。
  - 过期：``Settings.session_timeout_sec`` 秒。
  - 锁定：连续失败 ``Settings.login_fail_lock`` 次后锁定 5 分钟。

纯 Python 标准库实现，零第三方依赖。
"""

import secrets
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

from edge_platform.config import Settings

# 锁定时长（秒）
LOCK_DURATION_SEC = 300


@dataclass
class Session:
    """会话。"""

    session_id: str
    user_id: str
    role: str
    created_at: datetime
    expires_at: datetime


class SessionManager:
    """会话管理器（内存实现）。

    通过 ``login(username, password, backend)`` 完成认证并创建会话；
    ``verify(token)`` 校验会话存在且未过期；``revoke`` / ``revoke_all`` 撤销会话。
    连续登录失败 ``Settings.login_fail_lock`` 次后，该用户名被锁定 5 分钟。
    """

    def __init__(self, settings: Optional[Settings] = None):
        self._settings = settings or Settings.load()
        # token -> Session
        self._sessions: dict = {}
        # username -> 连续失败次数
        self._fail_counts: dict = {}
        # username -> 锁定到期 epoch（秒）
        self._lock_until: dict = {}

    def create(self, user) -> str:
        """为已认证用户创建会话，返回 session token。"""
        token = secrets.token_urlsafe(32)
        now = datetime.now(timezone.utc)
        session = Session(
            session_id=token,
            user_id=user.user_id,
            role=user.role,
            created_at=now,
            expires_at=now + timedelta(seconds=self._settings.session_timeout_sec),
        )
        self._sessions[token] = session
        return token

    def verify(self, token: str) -> Optional[Session]:
        """校验 token：存在且未过期返回 Session，否则返回 None（过期会话会被清除）。"""
        session = self._sessions.get(token)
        if session is None:
            return None
        if datetime.now(timezone.utc) > session.expires_at:
            self._sessions.pop(token, None)
            return None
        return session

    def revoke(self, token: str) -> None:
        """撤销单个会话。"""
        self._sessions.pop(token, None)

    def revoke_all(self, user_id: str) -> int:
        """撤销某用户的所有会话，返回撤销数量。"""
        to_remove = [t for t, s in self._sessions.items() if s.user_id == user_id]
        for token in to_remove:
            self._sessions.pop(token, None)
        return len(to_remove)

    def is_locked(self, username: str) -> bool:
        """用户名是否处于锁定状态。"""
        until = self._lock_until.get(username)
        if until is None:
            return False
        if time.time() < until:
            return True
        # 锁定已过期，清理
        self._lock_until.pop(username, None)
        self._fail_counts.pop(username, None)
        return False

    def login(self, username: str, password: str, backend=None) -> Optional[str]:
        """编排认证 + 会话创建 + 失败锁定。

        - 用户名被锁定时直接返回 None。
        - 认证成功：重置失败计数，创建会话，返回 token。
        - 认证失败：累加失败计数，达到阈值后锁定 5 分钟，返回 None。
        """
        if self.is_locked(username):
            return None
        from edge_platform.auth.identity import OfflineIdentityBackend
        if backend is None:
            backend = OfflineIdentityBackend()
        user = backend.authenticate(username, password)
        if user is None:
            count = self._fail_counts.get(username, 0) + 1
            self._fail_counts[username] = count
            if count >= self._settings.login_fail_lock:
                self._lock_until[username] = time.time() + LOCK_DURATION_SEC
            return None
        # 成功：清除失败计数与锁定
        self._fail_counts.pop(username, None)
        self._lock_until.pop(username, None)
        return self.create(user)

    def fail_count(self, username: str) -> int:
        """当前连续失败次数（测试/观察用途）。"""
        return self._fail_counts.get(username, 0)
