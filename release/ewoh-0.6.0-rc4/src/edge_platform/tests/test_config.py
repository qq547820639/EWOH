"""Task 32 配置外置与版本化：Settings 单元测试。

覆盖：
- 默认值（不读取 .env 文件、无环境变量时全部回落到合理默认）
- 环境变量覆盖（端口/主机/DB/超时/身份/TLS/日志等）
- 类型校验（端口/超时为 int；角色列表为 tuple；adapter_ports 为 dict{int: str}）
- adapter_ports 双格式解析（JSON 形式与逗号分隔 port:source 形式）
- 单例语义（load 缓存、force_reload 重新读取、reset 清除）

纯 Python 标准库 unittest；运行：
  PYTHONPATH=src python -m unittest edge_platform.tests.test_config -v
"""

import os
import sys
import unittest

# 支持 PYTHONPATH=src 与直接运行两种方式
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.config import Settings


def _ewoh_keys():
    return {k for k in os.environ if k.startswith("EWOH_")}


class _EnvIsolatedTest(unittest.TestCase):
    """隔离 EWOH_ 环境变量并重置单例的测试基类。"""

    def setUp(self):
        self._saved = dict(os.environ)
        for k in _ewoh_keys():
            os.environ.pop(k, None)
        Settings.reset()

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._saved)
        Settings.reset()


class SettingsDefaultsTest(_EnvIsolatedTest):
    def test_database_defaults(self):
        s = Settings.load()
        self.assertEqual(s.db_path, "demo.db")
        self.assertEqual(s.db_backend, "sqlite")
        self.assertEqual(s.db_url, "")

    def test_listen_defaults(self):
        s = Settings.load()
        self.assertEqual(s.host, "127.0.0.1")
        self.assertEqual(s.port, 8765)
        self.assertIsInstance(s.port, int)

    def test_adapter_ports_default(self):
        s = Settings.load()
        self.assertEqual(s.adapter_ports, {9001: "real", 9002: "controlled_test", 9003: "simulated"})
        self.assertIsInstance(s.adapter_ports, dict)
        self.assertTrue(all(isinstance(k, int) for k in s.adapter_ports))

    def test_thresholds_are_int(self):
        s = Settings.load()
        self.assertEqual(s.offline_after_sec, 10)
        self.assertIsInstance(s.offline_after_sec, int)
        self.assertEqual(s.evidence_window_sec, 30)
        self.assertIsInstance(s.evidence_window_sec, int)
        self.assertEqual(s.data_retention_days, 30)
        self.assertIsInstance(s.data_retention_days, int)
        self.assertEqual(s.session_timeout_sec, 3600)
        self.assertIsInstance(s.session_timeout_sec, int)
        self.assertEqual(s.login_fail_lock, 5)
        self.assertIsInstance(s.login_fail_lock, int)

    def test_log_level_default(self):
        self.assertEqual(Settings.load().log_level, "INFO")

    def test_auth_defaults(self):
        s = Settings.load()
        self.assertEqual(s.auth_backend, "offline")
        self.assertEqual(s.oidc_issuer, "")
        self.assertEqual(s.oidc_client_id, "")
        self.assertEqual(s.jwt_secret, "")

    def test_export_roles_default_is_tuple(self):
        roles = Settings.load().export_allowed_roles
        self.assertEqual(roles, ("admin", "safety_officer"))
        self.assertIsInstance(roles, tuple)

    def test_tls_defaults_empty(self):
        s = Settings.load()
        self.assertEqual(s.tls_cert, "")
        self.assertEqual(s.tls_key, "")


class SettingsEnvOverrideTest(_EnvIsolatedTest):
    def test_env_overrides_port_host_db(self):
        os.environ["EWOH_HOST"] = "0.0.0.0"  # nosec B104 - test env fixture
        os.environ["EWOH_PORT"] = "9000"
        os.environ["EWOH_DB_PATH"] = "/tmp/ewoh_test.db"  # nosec B108 - test env fixture
        os.environ["EWOH_DB_BACKEND"] = "postgres"
        os.environ["EWOH_DB_URL"] = "postgresql://u:p@h:5432/db"
        s = Settings.load()
        self.assertEqual(s.host, "0.0.0.0")  # nosec B104 - test assertion only
        self.assertEqual(s.port, 9000)
        self.assertEqual(s.db_path, "/tmp/ewoh_test.db")  # nosec B108 - test fixture path
        self.assertEqual(s.db_backend, "postgres")
        self.assertEqual(s.db_url, "postgresql://u:p@h:5432/db")

    def test_env_overrides_thresholds(self):
        os.environ["EWOH_OFFLINE_AFTER_SEC"] = "42"
        os.environ["EWOH_EVIDENCE_WINDOW_SEC"] = "60"
        os.environ["EWOH_DATA_RETENTION_DAYS"] = "7"
        os.environ["EWOH_SESSION_TIMEOUT_SEC"] = "7200"
        os.environ["EWOH_LOGIN_FAIL_LOCK"] = "3"
        s = Settings.load()
        self.assertEqual(s.offline_after_sec, 42)
        self.assertEqual(s.evidence_window_sec, 60)
        self.assertEqual(s.data_retention_days, 7)
        self.assertEqual(s.session_timeout_sec, 7200)
        self.assertEqual(s.login_fail_lock, 3)

    def test_env_overrides_auth_log_tls(self):
        os.environ["EWOH_AUTH_BACKEND"] = "oidc"
        os.environ["EWOH_OIDC_ISSUER"] = "https://idp.example.com"
        os.environ["EWOH_OIDC_CLIENT_ID"] = "ewoh-pilot"
        os.environ["EWOH_JWT_SECRET"] = "secret"
        os.environ["EWOH_TLS_CERT"] = "/certs/ewoh.crt"
        os.environ["EWOH_TLS_KEY"] = "/certs/ewoh.key"
        os.environ["EWOH_LOG_LEVEL"] = "DEBUG"
        s = Settings.load()
        self.assertEqual(s.auth_backend, "oidc")
        self.assertEqual(s.oidc_issuer, "https://idp.example.com")
        self.assertEqual(s.oidc_client_id, "ewoh-pilot")
        self.assertEqual(s.jwt_secret, "secret")
        self.assertEqual(s.tls_cert, "/certs/ewoh.crt")
        self.assertEqual(s.tls_key, "/certs/ewoh.key")
        self.assertEqual(s.log_level, "DEBUG")

    def test_export_roles_override_is_tuple(self):
        os.environ["EWOH_EXPORT_ALLOWED_ROLES"] = "admin,safety_officer,data_analyst"
        roles = Settings.load().export_allowed_roles
        self.assertEqual(roles, ("admin", "safety_officer", "data_analyst"))
        self.assertIsInstance(roles, tuple)

    def test_invalid_port_raises(self):
        os.environ["EWOH_PORT"] = "not-a-number"
        with self.assertRaises(ValueError):
            Settings.load(force_reload=True)

    def test_invalid_offline_threshold_raises(self):
        os.environ["EWOH_OFFLINE_AFTER_SEC"] = "abc"
        with self.assertRaises(ValueError):
            Settings.load(force_reload=True)


class AdapterPortsParsingTest(_EnvIsolatedTest):
    def test_json_format_from_env_example(self):
        # 与 deploy/.env.example 一致的 JSON 形式
        os.environ["EWOH_ADAPTER_PORTS"] = '{"9001":"real","9002":"controlled_test","9003":"simulated"}'
        ap = Settings.load().adapter_ports
        self.assertEqual(ap, {9001: "real", 9002: "controlled_test", 9003: "simulated"})
        self.assertTrue(all(isinstance(k, int) for k in ap))

    def test_comma_separated_format(self):
        os.environ["EWOH_ADAPTER_PORTS"] = "9001:real,9002:controlled_test,9003:simulated"
        ap = Settings.load().adapter_ports
        self.assertEqual(ap, {9001: "real", 9002: "controlled_test", 9003: "simulated"})

    def test_empty_mapping(self):
        os.environ["EWOH_ADAPTER_PORTS"] = ""
        self.assertEqual(Settings.load().adapter_ports, {})

    def test_invalid_json_raises(self):
        os.environ["EWOH_ADAPTER_PORTS"] = "{not-json"
        with self.assertRaises(ValueError):
            Settings.load(force_reload=True)

    def test_invalid_comma_entry_raises(self):
        # 缺少冒号分隔符
        os.environ["EWOH_ADAPTER_PORTS"] = "9001-real"
        with self.assertRaises(ValueError):
            Settings.load(force_reload=True)


class SettingsSingletonTest(_EnvIsolatedTest):
    def test_load_returns_same_instance(self):
        a = Settings.load()
        b = Settings.load()
        self.assertIs(a, b)

    def test_force_reload_creates_new_instance(self):
        a = Settings.load()
        os.environ["EWOH_PORT"] = "9999"
        b = Settings.load(force_reload=True)
        self.assertIsNot(a, b)
        self.assertEqual(a.port, 8765)
        self.assertEqual(b.port, 9999)

    def test_reset_clears_singleton(self):
        a = Settings.load()
        Settings.reset()
        b = Settings.load()
        self.assertIsNot(a, b)

    def test_direct_construction_reads_env(self):
        # 直接构造 Settings() 读取当前环境，不影响 load() 单例缓存
        os.environ["EWOH_PORT"] = "7777"
        direct = Settings()
        self.assertEqual(direct.port, 7777)
        self.assertIsNone(Settings._instance)
        self.assertEqual(Settings.load().port, 7777)


if __name__ == "__main__":
    unittest.main()
