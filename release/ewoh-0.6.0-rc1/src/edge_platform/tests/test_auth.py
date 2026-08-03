"""Task 27 身份认证与会话管理单元测试。

覆盖：
- OfflineIdentityBackend：预置账号认证成功/失败、错误密码、未知用户、add_user。
- OIDCIdentityBackend：stub 恒返回 None。
- get_identity_backend：offline / oidc / 未知后端。
- SessionManager：create/verify/revoke/revoke_all、过期会话、登录失败锁定与解锁。

纯 Python 标准库 unittest；运行：
  PYTHONPATH=src python -m unittest edge_platform.tests.test_auth -v
"""

import os
import sys
import time
import unittest
from datetime import datetime, timedelta, timezone

# 支持 PYTHONPATH=src 与直接运行两种方式
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.auth.identity import (
    IdentityBackend,
    OfflineIdentityBackend,
    OIDCIdentityBackend,
    User,
    get_identity_backend,
)
from edge_platform.auth.session import Session, SessionManager
from edge_platform.config import Settings


def _ewoh_keys():
    return {k for k in os.environ if k.startswith("EWOH_")}


class _EnvIsolatedTest(unittest.TestCase):
    """隔离 EWOH_ 环境变量并重置 Settings 单例。"""

    def setUp(self):
        self._saved = dict(os.environ)
        for k in _ewoh_keys():
            os.environ.pop(k, None)
        Settings.reset()

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._saved)
        Settings.reset()


# ---------- 身份后端 ----------
class OfflineIdentityBackendTest(unittest.TestCase):
    def test_seed_accounts_authenticate(self):
        backend = OfflineIdentityBackend()
        for username, password, expected_role in (
            ("admin", "admin123", "admin"),
            ("safety_officer", "safety123", "safety_officer"),
            ("operator", "operator123", "operator"),
        ):
            user = backend.authenticate(username, password)
            self.assertIsNotNone(user, f"{username} 应认证成功")
            self.assertIsInstance(user, User)
            self.assertEqual(user.username, username)
            self.assertEqual(user.role, expected_role)
            self.assertTrue(user.user_id)
            self.assertTrue(user.display_name)

    def test_wrong_password_returns_none(self):
        backend = OfflineIdentityBackend()
        self.assertIsNone(backend.authenticate("admin", "wrong"))
        self.assertIsNone(backend.authenticate("admin", "ADMIN123"))

    def test_unknown_user_returns_none(self):
        backend = OfflineIdentityBackend()
        self.assertIsNone(backend.authenticate("nobody", "whatever"))

    def test_salt_is_random_per_instance(self):
        # 两个实例的同一账号 salt 应不同（随机生成）
        b1 = OfflineIdentityBackend()
        b2 = OfflineIdentityBackend()
        self.assertNotEqual(b1._users["admin"]["salt"], b2._users["admin"]["salt"])
        # 但同一实例同一密码校验一致
        self.assertIsNotNone(b1.authenticate("admin", "admin123"))

    def test_add_user_then_authenticate(self):
        backend = OfflineIdentityBackend()
        backend.add_user("U-X", "analyst", "data_analyst", "分析师", "pass456")
        user = backend.authenticate("analyst", "pass456")
        self.assertIsNotNone(user)
        self.assertEqual(user.user_id, "U-X")
        self.assertEqual(user.role, "data_analyst")
        self.assertIsNone(backend.authenticate("analyst", "wrong"))


class OIDCIdentityBackendTest(_EnvIsolatedTest):
    def test_stub_returns_none(self):
        backend = OIDCIdentityBackend()
        self.assertIsNone(backend.authenticate("anyone", "anything"))


class GetIdentityBackendTest(_EnvIsolatedTest):
    def test_default_offline(self):
        backend = get_identity_backend()
        self.assertIsInstance(backend, OfflineIdentityBackend)

    def test_oidc(self):
        os.environ["EWOH_AUTH_BACKEND"] = "oidc"
        Settings.reset()
        backend = get_identity_backend()
        self.assertIsInstance(backend, OIDCIdentityBackend)

    def test_unknown_raises(self):
        os.environ["EWOH_AUTH_BACKEND"] = "ldap"
        Settings.reset()
        with self.assertRaises(ValueError):
            get_identity_backend()

    def test_identity_backend_is_abstract(self):
        with self.assertRaises(TypeError):
            IdentityBackend()  # type: ignore[abstract]


# ---------- 会话管理 ----------
class SessionManagerTest(_EnvIsolatedTest):
    def test_create_and_verify(self):
        mgr = SessionManager()
        user = OfflineIdentityBackend().authenticate("admin", "admin123")
        token = mgr.create(user)
        self.assertTrue(token)
        session = mgr.verify(token)
        self.assertIsNotNone(session)
        self.assertIsInstance(session, Session)
        self.assertEqual(session.user_id, user.user_id)
        self.assertEqual(session.role, user.role)
        self.assertIsInstance(session.created_at, datetime)
        self.assertIsInstance(session.expires_at, datetime)
        self.assertGreater(session.expires_at, session.created_at)

    def test_verify_unknown_token(self):
        mgr = SessionManager()
        self.assertIsNone(mgr.verify("nonexistent"))

    def test_revoke(self):
        mgr = SessionManager()
        user = OfflineIdentityBackend().authenticate("admin", "admin123")
        token = mgr.create(user)
        self.assertIsNotNone(mgr.verify(token))
        mgr.revoke(token)
        self.assertIsNone(mgr.verify(token))

    def test_revoke_unknown_token_no_error(self):
        mgr = SessionManager()
        mgr.revoke("nonexistent")  # 不应抛错

    def test_revoke_all(self):
        mgr = SessionManager()
        user = OfflineIdentityBackend().authenticate("admin", "admin123")
        t1 = mgr.create(user)
        t2 = mgr.create(user)
        other = OfflineIdentityBackend().authenticate("operator", "operator123")
        t3 = mgr.create(other)
        n = mgr.revoke_all(user.user_id)
        self.assertEqual(n, 2)
        self.assertIsNone(mgr.verify(t1))
        self.assertIsNone(mgr.verify(t2))
        self.assertIsNotNone(mgr.verify(t3))

    def test_revoke_all_no_sessions(self):
        mgr = SessionManager()
        self.assertEqual(mgr.revoke_all("U-NONE"), 0)

    def test_expired_session_is_invalid_and_cleared(self):
        settings = Settings()
        settings.session_timeout_sec = 1
        mgr = SessionManager(settings)
        user = OfflineIdentityBackend().authenticate("admin", "admin123")
        token = mgr.create(user)
        self.assertIsNotNone(mgr.verify(token))
        # 手动把过期时间改到过去
        mgr._sessions[token].expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        self.assertIsNone(mgr.verify(token))
        # 过期会话已被清除
        self.assertNotIn(token, mgr._sessions)


# ---------- 登录失败锁定 ----------
class LoginFailLockTest(_EnvIsolatedTest):
    def test_login_success_returns_token(self):
        mgr = SessionManager()
        token = mgr.login("admin", "admin123")
        self.assertTrue(token)
        self.assertIsNotNone(mgr.verify(token))
        # 成功后失败计数为 0
        self.assertEqual(mgr.fail_count("admin"), 0)

    def test_login_wrong_password_no_token(self):
        mgr = SessionManager()
        self.assertIsNone(mgr.login("admin", "wrong"))
        self.assertEqual(mgr.fail_count("admin"), 1)
        # 未锁定
        self.assertFalse(mgr.is_locked("admin"))

    def test_login_lock_after_threshold(self):
        os.environ["EWOH_LOGIN_FAIL_LOCK"] = "3"
        Settings.reset()
        mgr = SessionManager()
        # 前两次失败不锁定
        self.assertIsNone(mgr.login("admin", "bad"))
        self.assertFalse(mgr.is_locked("admin"))
        self.assertIsNone(mgr.login("admin", "bad"))
        self.assertFalse(mgr.is_locked("admin"))
        # 第三次失败触发锁定
        self.assertIsNone(mgr.login("admin", "bad"))
        self.assertTrue(mgr.is_locked("admin"))
        self.assertEqual(mgr.fail_count("admin"), 3)
        # 锁定后即使正确密码也无法登录
        self.assertIsNone(mgr.login("admin", "admin123"))

    def test_login_success_resets_fail_count(self):
        os.environ["EWOH_LOGIN_FAIL_LOCK"] = "5"
        Settings.reset()
        mgr = SessionManager()
        mgr.login("admin", "bad")
        mgr.login("admin", "bad")
        self.assertEqual(mgr.fail_count("admin"), 2)
        # 成功登录重置计数
        token = mgr.login("admin", "admin123")
        self.assertTrue(token)
        self.assertEqual(mgr.fail_count("admin"), 0)
        # 再次失败从 1 开始
        mgr.login("admin", "bad")
        self.assertEqual(mgr.fail_count("admin"), 1)

    def test_lock_expires_after_5_minutes(self):
        os.environ["EWOH_LOGIN_FAIL_LOCK"] = "2"
        Settings.reset()
        mgr = SessionManager()
        mgr.login("admin", "bad")
        mgr.login("admin", "bad")
        self.assertTrue(mgr.is_locked("admin"))
        # 模拟锁定到期：手动把 lock_until 设到过去
        mgr._lock_until["admin"] = time.time() - 1
        self.assertFalse(mgr.is_locked("admin"))
        # 锁定到期后正确密码可登录
        token = mgr.login("admin", "admin123")
        self.assertTrue(token)

    def test_lock_per_username_isolated(self):
        os.environ["EWOH_LOGIN_FAIL_LOCK"] = "2"
        Settings.reset()
        mgr = SessionManager()
        # admin 锁定
        mgr.login("admin", "bad")
        mgr.login("admin", "bad")
        self.assertTrue(mgr.is_locked("admin"))
        # operator 未受影响
        self.assertFalse(mgr.is_locked("operator"))
        token = mgr.login("operator", "operator123")
        self.assertTrue(token)

    def test_login_with_custom_backend(self):
        mgr = SessionManager()
        backend = OfflineIdentityBackend()
        backend.add_user("U-X", "analyst", "data_analyst", "分析师", "pw")
        token = mgr.login("analyst", "pw", backend=backend)
        self.assertTrue(token)
        session = mgr.verify(token)
        self.assertIsNotNone(session)
        self.assertEqual(session.role, "data_analyst")


if __name__ == "__main__":
    unittest.main()
