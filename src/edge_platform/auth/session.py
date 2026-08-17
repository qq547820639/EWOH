"""会话管理（Task 27）。

提供基于内存 dict 的会话管理与登录失败锁定：
- ``Session``：会话数据载体（session_id/user_id/role/created_at/expires_at）。
- ``SessionManager``：创建/校验/撤销会话；``login`` 编排认证 + 会话创建 + 失败锁定。
  - 会话 token：``secrets.token_urlsafe(32)``。
  - 过期：``Settings.session_timeout_sec`` 秒。
  - 锁定：连续失败 ``Settings.login_fail_lock`` 次后锁定 5 分钟。
  - EDGE-017（2026-08-17 审计整改）：失败计数除按用户名外增加按来源 IP 维度，
    旋转用户名无法绕过锁定；IP 锁定同样持续 ``LOCK_DURATION_SEC``。
  - EDGE-015：过期会话/失败计数/锁定条目周期性清理（惰性触发，60s 间隔），
    长时运行字典不再无界增长。

纯 Python 标准库实现，零第三方依赖。
"""

import secrets
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

from edge_platform.config import Settings

# 锁定时长（秒）
LOCK_DURATION_SEC = 300
# EDGE-015：惰性清理最小间隔（秒）
_SWEEP_INTERVAL_SEC = 60


@dataclass
class Session:
    """会话。"""

    session_id: str
    user_id: str
    role: str
    created_at: datetime
    expires_at: datetime


class SessionManager:
    """会话管理器（内存实现，线程安全）。

    通过 ``login(username, password, backend, client_ip=None)`` 完成认证并创建会话；
    ``verify(token)`` 校验会话存在且未过期；``revoke`` / ``revoke_all`` 撤销会话。
    连续登录失败 ``Settings.login_fail_lock`` 次后，该用户名与来源 IP 分别被锁定
    5 分钟（任一命中即拒绝，防用户名旋转与单 IP 暴力破解）。
    """

    def __init__(self, settings: Optional[Settings] = None):
        self._settings = settings or Settings.load()
        self._lock = threading.RLock()
        # token -> Session
        self._sessions: dict = {}
        # username -> 连续失败次数
        self._fail_counts: dict = {}
        # username -> 锁定到期 epoch（秒）
        self._lock_until: dict = {}
        # EDGE-017：IP 维度失败计数/锁定（旋转用户名绕不过）
        self._ip_fail_counts: dict = {}
        self._ip_lock_until: dict = {}
        # EDGE-015：惰性清理时间戳（monotonic）
        self._last_sweep = time.monotonic()

    # ---- EDGE-015：惰性清理 ----

    def _sweep_if_due(self) -> None:
        """周期清理过期会话与失效的失败计数/锁定条目（防字典无界增长）。"""
        now_mono = time.monotonic()
        if now_mono - self._last_sweep < _SWEEP_INTERVAL_SEC:
            return
        self._last_sweep = now_mono
        now = datetime.now(timezone.utc)
        now_epoch = time.time()
        with self._lock:
            expired_tokens = [
                t for t, s in self._sessions.items() if now > s.expires_at
            ]
            for t in expired_tokens:
                self._sessions.pop(t, None)
            for mapping in (self._lock_until, self._ip_lock_until):
                for k in [k for k, until in mapping.items() if until <= now_epoch]:
                    mapping.pop(k, None)
                    if mapping is self._lock_until:
                        self._fail_counts.pop(k, None)
                    else:
                        self._ip_fail_counts.pop(k, None)

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
        with self._lock:
            self._sweep_if_due()
            self._sessions[token] = session
        return token

    def verify(self, token: str) -> Optional[Session]:
        """校验 token：存在且未过期返回 Session，否则返回 None（过期会话会被清除）。"""
        with self._lock:
            session = self._sessions.get(token)
            if session is None:
                return None
            if datetime.now(timezone.utc) > session.expires_at:
                self._sessions.pop(token, None)
                return None
            return session

    def revoke(self, token: str) -> None:
        """撤销单个会话。"""
        with self._lock:
            self._sessions.pop(token, None)

    def revoke_all(self, user_id: str) -> int:
        """撤销某用户的所有会话，返回撤销数量。"""
        with self._lock:
            to_remove = [t for t, s in self._sessions.items() if s.user_id == user_id]
            for token in to_remove:
                self._sessions.pop(token, None)
        return len(to_remove)

    def is_locked(self, username: str) -> bool:
        """用户名是否处于锁定状态。"""
        with self._lock:
            until = self._lock_until.get(username)
            if until is None:
                return False
            if time.time() < until:
                return True
            # 锁定已过期，清理
            self._lock_until.pop(username, None)
            self._fail_counts.pop(username, None)
            return False

    def is_ip_locked(self, client_ip: str) -> bool:
        """EDGE-017：来源 IP 是否处于登录锁定状态。"""
        if not client_ip:
            return False
        with self._lock:
            until = self._ip_lock_until.get(client_ip)
            if until is None:
                return False
            if time.time() < until:
                return True
            self._ip_lock_until.pop(client_ip, None)
            self._ip_fail_counts.pop(client_ip, None)
            return False

    def login(self, username: str, password: str, backend=None, client_ip: str = None) -> Optional[str]:
        """编排认证 + 会话创建 + 失败锁定（用户名与来源 IP 双维度）。

        - 用户名或来源 IP 被锁定时直接返回 None。
        - 认证成功：重置该用户名失败计数，创建会话，返回 token。
        - 认证失败：用户名与 IP（若提供）失败计数各 +1，达到阈值后分别锁定 5 分钟。
        """
        with self._lock:
            self._sweep_if_due()
        if self.is_locked(username):
            return None
        if client_ip and self.is_ip_locked(client_ip):
            return None
        from edge_platform.auth.identity import OfflineIdentityBackend

        if backend is None:
            backend = OfflineIdentityBackend()
        user = backend.authenticate(username, password)
        if user is None:
            with self._lock:
                count = self._fail_counts.get(username, 0) + 1
                self._fail_counts[username] = count
                if count >= self._settings.login_fail_lock:
                    self._lock_until[username] = time.time() + LOCK_DURATION_SEC
                if client_ip:
                    ip_count = self._ip_fail_counts.get(client_ip, 0) + 1
                    self._ip_fail_counts[client_ip] = ip_count
                    if ip_count >= self._settings.login_fail_lock:
                        self._ip_lock_until[client_ip] = time.time() + LOCK_DURATION_SEC
            return None
        # 成功：清除该用户名的失败计数与锁定（IP 计数保留至自然过期，防旋转用户名）
        with self._lock:
            self._fail_counts.pop(username, None)
            self._lock_until.pop(username, None)
        return self.create(user)

    def fail_count(self, username: str) -> int:
        """当前连续失败次数（测试/观察用途）。"""
        with self._lock:
            return self._fail_counts.get(username, 0)

    def ip_fail_count(self, client_ip: str) -> int:
        """EDGE-017：来源 IP 当前连续失败次数（测试/观察用途）。"""
        with self._lock:
            return self._ip_fail_counts.get(client_ip, 0)
