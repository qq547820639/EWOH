#!/usr/bin/env python3
"""认证/身份域路由（Task 9 / P2）。

GET /api/me、GET /api/security/policy、POST /api/auth/login、POST /api/auth/refresh，
以及共享安全工具 bearer_token / enforce_export_role（供 telemetry 域复用）。
逻辑自 server.py 原 Handler 机械抽取：self→h、闭包 ctx→显式参数，响应契约不变。
"""

import threading
import time
import uuid

from edge_platform.config import Settings
from edge_platform.rbac import check_export_role

from . import Route, dispatch_routes, exact
from ._util import now_iso, runtime_mode, session_manager

# EDGE-024：同 token 并发 refresh 的原子段锁（verify+revoke+create），
# 防止两个并发请求均 verify 成功后各自 revoke+create 造成会话翻倍。
_refresh_lock = threading.Lock()


def bearer_token(h):
    """从 Authorization header 提取 Bearer token；缺失返回空串。"""
    auth = (h.headers.get("Authorization", "") or "").strip()
    if auth.startswith("Bearer "):
        return auth[len("Bearer ") :].strip()
    return ""


def enforce_export_role(ctx, h):
    """导出端点 RBAC 校验：携带 Bearer token 且会话有效时，校验角色是否在导出允许名单内。

    production 下 fail-closed：无 token / 会话无效 / 认证服务不可用一律拒绝（防泄露原始遥测）；
    非 production（development/simulation）保留演示兼容：无 token 或会话无效时放行。
    返回 True 表示已发送错误响应（调用方应直接 return），False 表示放行。
    """
    is_prod = runtime_mode() == "production"
    token = bearer_token(h)
    if not token:
        if is_prod:
            h._new_error("unauthorized", "production 导出必须携带有效 Bearer token", 401)
            return True
        return False
    sm = session_manager()
    if sm is None:
        if is_prod:
            h._new_error("auth_unavailable", "认证服务未就绪，拒绝导出", 503)
            return True
        return False
    try:
        session = sm.verify(token)
    except Exception:
        if is_prod:
            h._new_error("unauthorized", "token 校验失败", 401)
            return True
        return False
    if session is None:
        if is_prod:
            h._new_error("unauthorized", "token 无效或已过期", 401)
            return True
        return False
    allowed = Settings.load().export_allowed_roles
    if not check_export_role(session.role, allowed):
        h._new_error("forbidden", "当前角色无导出权限", 403)
        return True
    return False


def api_auth_login(ctx, h, payload, client_ip=None):
    """POST /api/auth/login — {username, password} → {token, user}。

    auth 模块未就绪时使用演示用 token（uuid4 hex）；auth 就绪后委派 SessionManager。
    EDGE-017：登录失败计数同时按用户名与来源 IP 维度（SessionManager 内实现），
    旋转用户名无法绕过锁定。
    """
    username = (payload.get("username") or "").strip()
    password = (payload.get("password") or "").strip()
    if not username or not password:
        return h._new_error("invalid_credentials", "用户名或密码不能为空", 400)
    h._audit_target_type = "auth"
    h._audit_target_id = username
    sm = session_manager()
    if sm is not None:
        token = sm.login(username, password, client_ip=client_ip)
        if token is None:
            return h._new_error("invalid_credentials", "用户名或密码错误或已锁定", 401)
        session = sm.verify(token)
        user = {"user_id": session.user_id, "username": username, "role": session.role}
        return h.send_json({"token": token, "user": user})
    # auth 模块未就绪：production 必须 fail-closed（不生成任何演示 token）
    if runtime_mode() == "production":
        return h._new_error(
            "auth_unavailable", "认证服务未就绪，拒绝登录（production 不提供演示凭据）", 503
        )
    # 非 production（development/simulation）：演示用简单 token（L2：24h 过期 + 惰性清理）。
    # EDGE-027：演示 token 角色由 admin 收敛为 operator（受限角色，无规则/模型/派工管理权）。
    h._demo_token_cleanup()
    token = uuid.uuid4().hex
    user = {"user_id": username, "username": username, "role": "operator"}
    with h._tokens_lock:
        h._tokens[token] = {"user": user, "exp": time.time() + h._TOKEN_TTL}
    return h.send_json({"token": token, "user": user})


def api_auth_refresh(ctx, h, req_meta):
    """POST /api/auth/refresh — Bearer token → 新 token（旋转）。"""
    token = bearer_token(h)
    if not token:
        return h._new_error("unauthorized", "缺少 Authorization Bearer token", 401)
    sm = session_manager()
    if sm is None:
        # 认证不可用时绝不落入演示 token 旋转：production 必须显式拒绝。
        if runtime_mode() == "production":
            return h._new_error("auth_unavailable", "认证服务未就绪，拒绝刷新会话", 503)
    else:
        # EDGE-024：verify+revoke+create 原子段——并发刷新只有一个成功。
        with _refresh_lock:
            session = sm.verify(token)
            if session is None:
                return h._new_error("unauthorized", "token 无效或已过期", 401)
            sm.revoke(token)
            # 用同一用户身份创建新会话
            from edge_platform.auth import User  # noqa: F401

            new_token = sm.create(
                User(
                    user_id=session.user_id,
                    username=session.username or session.user_id,
                    role=session.role,
                    display_name="",
                )
            )
        user = {"user_id": session.user_id, "username": session.username or session.user_id, "role": session.role}
        h._audit_target_type = "auth"
        h._audit_target_id = session.user_id
        return h.send_json({"token": new_token, "user": user})
    # fallback：演示用 token 旋转（L2：校验过期 + 新 token 带新 exp）
    with h._tokens_lock:
        entry = h._tokens.get(token)
        if entry is None or entry.get("exp", 0) <= time.time():
            return h._new_error("unauthorized", "token 无效或已过期", 401)
        user = entry.get("user")
        new_token = uuid.uuid4().hex
        h._tokens[new_token] = {"user": user, "exp": time.time() + h._TOKEN_TTL}
        del h._tokens[token]
    h._audit_target_type = "auth"
    h._audit_target_id = user.get("user_id") or user.get("username")
    return h.send_json({"token": new_token, "user": user})


def api_me(ctx, h, req_meta):
    """GET /api/me — Bearer token → 当前用户信息。"""
    token = bearer_token(h)
    if not token:
        return h._new_error("unauthorized", "缺少 Authorization Bearer token", 401)
    sm = session_manager()
    if sm is not None:
        session = sm.verify(token)
        if session is None:
            return h._new_error("unauthorized", "token 无效或已过期", 401)
        return h.send_json(
            {
                "user": {
                    "user_id": session.user_id,
                    "username": session.username or session.user_id,
                    "role": session.role,
                }
            }
        )
    # EDGE-052：production 下认证服务未就绪必须 fail-closed（503），
    # 不落演示 token 分支（生产环境不提供演示凭据）。
    if runtime_mode() == "production":
        return h._new_error("auth_unavailable", "认证服务未就绪，拒绝身份查询", 503)
    # fallback：演示用 token（L2：校验过期；仅 development/simulation）
    with h._tokens_lock:
        entry = h._tokens.get(token)
    if not entry or entry.get("exp", 0) <= time.time():
        return h._new_error("unauthorized", "token 无效或已过期", 401)
    return h.send_json({"user": entry.get("user")})


def api_security_policy(ctx, h, req_meta):
    """GET /api/security/policy — 返回当前安全配置（不暴露密钥）。

    Task 30：仅返回非敏感字段（tls_enabled / session_timeout /
    login_fail_lock），tls_cert/tls_key/jwt_secret 等敏感值不返回。
    """
    try:
        s = Settings.load()
        tls_enabled = bool(s.tls_cert and s.tls_key)
        session_timeout = s.session_timeout_sec
        login_fail_lock = s.login_fail_lock
    except Exception:
        tls_enabled, session_timeout, login_fail_lock = False, 0, 0
    return h.send_json(
        {
            "tls_enabled": tls_enabled,
            "session_timeout_sec": session_timeout,
            "login_fail_lock": login_fail_lock,
            "now": now_iso(),
            # 安全说明：敏感字段（tls_cert/tls_key/jwt_secret/oidc_client_id）
            # 永不通过此端点返回。
            "redacted": ["tls_cert", "tls_key", "jwt_secret", "oidc_client_id"],
        }
    )


def route_auth_login(ctx, h, req_meta):
    client_ip = req_meta.client[0] if getattr(req_meta, "client", None) else None
    return api_auth_login(ctx, h, req_meta.body, client_ip=client_ip)


DOMAIN_ROUTES = [
    Route("GET", "/api/security/policy", exact("/api/security/policy"), api_security_policy),
    Route("GET", "/api/me", exact("/api/me"), api_me),
    Route("POST", "/api/auth/login", exact("/api/auth/login"), route_auth_login),
    Route("POST", "/api/auth/refresh", exact("/api/auth/refresh"), api_auth_refresh),
]


def handle_auth(ctx, h, req_meta):
    return dispatch_routes(DOMAIN_ROUTES, ctx, h, req_meta)
