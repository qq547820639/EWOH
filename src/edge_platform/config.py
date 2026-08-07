#!/usr/bin/env python3
"""EWOH 平台统一配置加载（Task 32：配置外置与版本化）。

从环境变量读取配置（不引入 python-dotenv，统一用 os.environ.get）；
即便不读取 .env 文件、未设置任何环境变量，全部配置项也均有合理默认值，
保证现有测试与单机演示零配置即可运行。

覆盖配置项（对照 deploy/.env.example）：
- 数据库：EWOH_DB_PATH / EWOH_DB_BACKEND / EWOH_DB_URL
- 服务监听：EWOH_HOST / EWOH_PORT
- 适配层：EWOH_ADAPTER_PORTS / EWOH_OFFLINE_AFTER_SEC / EWOH_EVIDENCE_WINDOW_SEC
          / EWOH_DATA_RETENTION_DAYS
- 日志：EWOH_LOG_LEVEL
- 身份与权限：EWOH_AUTH_BACKEND / EWOH_OIDC_ISSUER / EWOH_OIDC_CLIENT_ID
              / EWOH_JWT_SECRET / EWOH_SESSION_TIMEOUT_SEC / EWOH_LOGIN_FAIL_LOCK
- 导出权限：EWOH_EXPORT_ALLOWED_ROLES
- TLS：EWOH_TLS_CERT / EWOH_TLS_KEY

纯 Python 标准库实现，零第三方依赖。
"""

import json
import os

_DEFAULT_ADAPTER_PORTS = "9001:real,9002:controlled_test,9003:simulated"
_DEFAULT_EXPORT_ROLES = "admin,safety_officer"


def _get_int(name, default):
    """从环境变量读取整数；未设置或空串时回落到 default，非法值抛 ValueError。"""
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError as e:
        raise ValueError(f"{name} 必须为整数，得到: {raw!r}") from e


def _parse_adapter_ports(raw):
    """解析适配器端口映射，返回 {port(int): source_type(str)}。

    支持两种格式：
    - JSON 对象：'{"9001":"real","9002":"controlled_test"}'（与 deploy/.env.example 一致）
    - 逗号分隔的 port:source：'9001:real,9002:controlled_test'（默认值形式）
    空串返回 {}；非法 JSON 或缺少冒号的条目抛 ValueError。
    """
    raw = (raw or "").strip()
    if not raw:
        return {}
    if raw.startswith("{"):
        try:
            obj = json.loads(raw)
        except ValueError as e:
            raise ValueError(f"EWOH_ADAPTER_PORTS JSON 解析失败: {e}") from e
        return {int(k): str(v) for k, v in obj.items()}
    result = {}
    for item in raw.split(","):
        item = item.strip()
        if not item:
            continue
        if ":" not in item:
            raise ValueError(f"EWOH_ADAPTER_PORTS 条目格式应为 port:source，得到: {item!r}")
        port_str, source = item.split(":", 1)
        result[int(port_str.strip())] = source.strip()
    return result


def _parse_roles(raw):
    """解析逗号分隔的角色列表，返回 tuple；空串返回 ()。"""
    if not raw:
        return ()
    return tuple(r.strip() for r in raw.split(",") if r.strip())


class Settings:
    """平台运行配置（单例）。

    通过 Settings.load() 获取实例：首次调用从环境变量读取并缓存，
    后续调用返回同一实例。force_reload=True 强制重新读取环境变量；
    reset() 清除缓存（测试用途）。也可直接构造 Settings() 获取独立实例。
    """

    _instance = None

    def __init__(self):
        # ---- 数据库 ----
        self.db_path = os.environ.get("EWOH_DB_PATH", "demo.db")
        self.db_backend = os.environ.get("EWOH_DB_BACKEND", "sqlite")
        self.db_url = os.environ.get("EWOH_DB_URL", "")
        # ---- 服务监听 ----
        self.host = os.environ.get("EWOH_HOST", "127.0.0.1")
        self.port = _get_int("EWOH_PORT", 8765)
        # ---- 适配层 ----
        self.adapter_ports = _parse_adapter_ports(os.environ.get("EWOH_ADAPTER_PORTS", _DEFAULT_ADAPTER_PORTS))
        self.offline_after_sec = _get_int("EWOH_OFFLINE_AFTER_SEC", 10)
        self.evidence_window_sec = _get_int("EWOH_EVIDENCE_WINDOW_SEC", 30)
        self.data_retention_days = _get_int("EWOH_DATA_RETENTION_DAYS", 30)
        # ---- 日志 ----
        self.log_level = os.environ.get("EWOH_LOG_LEVEL", "INFO")
        # ---- 身份与权限 ----
        self.auth_backend = os.environ.get("EWOH_AUTH_BACKEND", "offline")
        self.oidc_issuer = os.environ.get("EWOH_OIDC_ISSUER", "")
        self.oidc_client_id = os.environ.get("EWOH_OIDC_CLIENT_ID", "")
        self.jwt_secret = os.environ.get("EWOH_JWT_SECRET", "")
        self.session_timeout_sec = _get_int("EWOH_SESSION_TIMEOUT_SEC", 3600)
        self.login_fail_lock = _get_int("EWOH_LOGIN_FAIL_LOCK", 5)
        # ---- 导出权限 ----
        self.export_allowed_roles = _parse_roles(os.environ.get("EWOH_EXPORT_ALLOWED_ROLES", _DEFAULT_EXPORT_ROLES))
        # ---- TLS ----
        self.tls_cert = os.environ.get("EWOH_TLS_CERT", "")
        self.tls_key = os.environ.get("EWOH_TLS_KEY", "")
        # ---- 视觉理解（演示模式默认后端：火山方舟 Ark） ----
        # 读取 EWOH_ARK_API_KEY 等环境变量；未配置时视角理解返回明确错误，不伪造描述
        self.ark_api_key = os.environ.get("EWOH_ARK_API_KEY", "")
        self.ark_base_url = os.environ.get(
            "EWOH_ARK_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3"
        )
        self.ark_model = os.environ.get("EWOH_ARK_MODEL", "doubao-seed-2-1-pro-260628")

    @classmethod
    def load(cls, force_reload=False):
        """返回单例 Settings；force_reload=True 时重新读取环境变量。"""
        if cls._instance is None or force_reload:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset(cls):
        """清除缓存的单例（测试用途）。"""
        cls._instance = None
