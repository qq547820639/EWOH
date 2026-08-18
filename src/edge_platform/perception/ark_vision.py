"""Ark 视觉理解接入（演示模式默认视觉理解后端）。

对应分享中的默认调用方式：调用火山方舟视觉模型，对输入图片返回自然语言描述
（默认提问"你看见了什么？"）。演示场景未显式传入图片时，默认使用官方案例图。

- 纯标准库实现（urllib），零第三方依赖；
- 配置经 Settings 从环境变量读取：EWOH_ARK_API_KEY / EWOH_ARK_BASE_URL / EWOH_ARK_MODEL；
- 未配置 API Key 时返回明确的结构化错误，绝不伪造描述。

说明：分享中的示例使用 `/responses` + `input_image` 类型，经实测该模型不支持该类型；
本项目改用标准 Chat Completions（`/chat/completions` + `image_url`）完成同样的视觉理解。
"""

import http.client
import ipaddress
import json
import socket
import ssl
from urllib.parse import urljoin, urlparse

from edge_platform.config import Settings

DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"
DEFAULT_MODEL = "doubao-seed-2-1-pro-260628"
DEFAULT_QUESTION = "你看见了什么？"
#: 演示模式默认图片（未显式传入 image_url 时使用）
DEFAULT_DEMO_IMAGE = "https://ark-project.tos-cn-beijing.volces.com/doc_image/ark_demo_img_1.png"

#: R2-EDM-02：手动逐跳重定向的最大跳数上限，超限即 fail-closed 拒绝。
MAX_REDIRECTS = 3


def _addr_is_public(addr):
    """R2-EDM-02：地址公网属性判定（环回/内网/链路本地/保留/组播/未指定均非公网）。"""
    return not (
        addr.is_loopback
        or addr.is_private
        or addr.is_link_local
        or addr.is_reserved
        or addr.is_multicast
        or addr.is_unspecified
    )


def resolve_public_ip(host):
    """R2-EDM-02：解析 host 并校验全部解析地址为公网，返回固定连接 IP。

    校验与后续连接共用同一次 getaddrinfo 结果（连接层不再自行二次解析），
    消除"校验时解析 A 记录、连接时解析 B 记录"的 DNS rebinding TOCTOU 窗口。
    返回 (ip, reason)；失败时 ip 为 None（fail-closed）。
    """
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except OSError:
        return None, "dns_resolution_failed"
    for info in infos:
        ip = info[4][0]
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            continue
        if not _addr_is_public(addr):
            return None, "internal_address"
    for info in infos:
        ip = info[4][0]
        try:
            ipaddress.ip_address(ip)
        except ValueError:
            continue
        return ip, None
    return None, "no_valid_address"


def validate_outbound_url(raw_url, label="url"):
    """SSRF 防护（P1 安全修复）：出站地址仅允许公网 http/https，且解析后
    不含环回/内网/链路本地/保留/组播/未指定地址（阻断指向 169.254.169.254、
    localhost、10.x/172.16-31.x/192.168.x 等的服务端出站请求）。

    返回 (ok, reason)；ok=False 时调用方必须拒绝。
    """
    try:
        parsed = urlparse(raw_url)
    except ValueError:
        return False, "invalid_url"
    if parsed.scheme not in ("http", "https"):
        return False, "invalid_scheme"
    host = parsed.hostname
    if not host:
        return False, "missing_host"
    # R2-EDM-02：复用 resolve_public_ip 的单次解析校验逻辑，行为与原实现一致。
    ip, reason = resolve_public_ip(host)
    if ip is None:
        return False, reason
    return True, None


class _OutboundBlocked(Exception):
    """R2-EDM-02：出站请求被安全校验拒绝（fail-closed），reason 说明原因。"""

    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


class _PinnedHTTPConnection(http.client.HTTPConnection):
    """R2-EDM-02：固定 IP 直连的 HTTP 连接。

    self.host 仍为原域名（Host 头自动取自它），但 connect 只连校验期固定
    下来的 IP，杜绝连接层的二次 DNS 解析。
    """

    def __init__(self, host, port, pinned_ip, timeout):
        super().__init__(host, port, timeout=timeout)
        self._pinned_ip = pinned_ip

    def connect(self):
        self.sock = socket.create_connection((self._pinned_ip, self.port), self.timeout)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """R2-EDM-02：固定 IP 直连的 HTTPS 连接。

    TCP 只连校验期固定下来的 IP；TLS SNI 与证书主机名校验仍用原域名
    （server_hostname=self.host），安全性不降级。
    """

    def __init__(self, host, port, pinned_ip, timeout, context):
        super().__init__(host, port, timeout=timeout, context=context)
        self._pinned_ip = pinned_ip

    def connect(self):
        sock = socket.create_connection((self._pinned_ip, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


def _pinned_request(url, method, headers, body, timeout=60):
    """R2-EDM-02：校验后固定 IP 直连发请求（不使用 urlopen 的自动解析/重定向）。

    返回 (status, headers, body_bytes)；校验失败抛 _OutboundBlocked。
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise _OutboundBlocked("invalid_scheme")
    host = parsed.hostname
    if not host:
        raise _OutboundBlocked("missing_host")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    ip, reason = resolve_public_ip(host)
    if ip is None:
        raise _OutboundBlocked(reason)
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    if parsed.scheme == "https":
        conn = _PinnedHTTPSConnection(
            host, port, ip, timeout, context=ssl.create_default_context()
        )
    else:
        conn = _PinnedHTTPConnection(host, port, ip, timeout)
    try:
        conn.request(method, path, body=body, headers=headers)
        resp = conn.getresponse()
        data = resp.read()
        return resp.status, resp.headers, data
    finally:
        conn.close()


def _extract_content(raw):
    """从 Chat Completions 响应中提取助手正文文本。

    choices[0].message.content 为字符串；若为空则回落到 reasoning_content。
    """
    data = json.loads(raw)
    choices = data.get("choices") or []
    if not choices:
        return ""
    msg = choices[0].get("message") or {}
    content = msg.get("content") or ""
    if isinstance(content, list):  # 兼容结构化 content 数组
        parts = []
        for c in content:
            if isinstance(c, dict) and c.get("type") == "text":
                parts.append(c.get("text", ""))
        return "\n".join(p for p in parts if p)
    return str(content)


def resolve_config(api_key="", base_url="", model=""):
    """按优先级解析视觉理解配置：请求级参数 > 环境变量 > 默认值。"""
    s = Settings.load()
    env_key = getattr(s, "ark_api_key", "") or ""
    env_base = getattr(s, "ark_base_url", "") or DEFAULT_BASE_URL
    env_model = getattr(s, "ark_model", "") or DEFAULT_MODEL
    return {
        "api_key": (api_key or env_key or ""),
        "base_url": (base_url or env_base or DEFAULT_BASE_URL),
        "model": (model or env_model or DEFAULT_MODEL),
    }


def describe_image(image_url="", question=DEFAULT_QUESTION, api_key="", base_url="", model=""):
    """调用 Ark 视觉模型描述图片。

    :param image_url: 图片地址；为空时使用演示模式默认图。
    :param question:  提问文本，默认为"你看见了什么？"。
    :param api_key:   可选，请求级 API Key 覆盖（优先级最高）。
    :param base_url:  可选，请求级 Base URL 覆盖。
    :param model:     可选，请求级模型名覆盖。
    :return: dict，含 ok/backend/model/answer；失败时含 error。
    """
    cfg = resolve_config(api_key, base_url, model)
    api_key = cfg["api_key"]
    base_url = cfg["base_url"]
    model = cfg["model"]
    if not api_key:
        return {
            "ok": False,
            "backend": "ark",
            "model": model,
            "error": "未配置 EWOH_ARK_API_KEY，无法调用视觉理解模型。",
            "answer": "",
        }
    # P1 安全修复（SSRF）：出站 API 地址必须是公网 http/https（拒绝内网/环回/链路本地/
    # 云元数据地址），即使请求级 base_url 覆盖也不能把服务端出站请求指向内部网络。
    ok, reason = validate_outbound_url(base_url, label="base_url")
    if not ok:
        return {
            "ok": False,
            "backend": "ark",
            "model": model,
            "error": f"base_url 不安全（{reason}）：仅允许公网 http/https 地址。",
            "answer": "",
        }
    if image_url:
        ok_img, reason_img = validate_outbound_url(image_url, label="image_url")
        if not ok_img:
            return {
                "ok": False,
                "backend": "ark",
                "model": model,
                "error": f"image_url 不安全（{reason_img}）：仅允许公网 http/https 图片地址。",
                "answer": "",
            }
    url = base_url.rstrip("/") + "/chat/completions"
    body = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": image_url or DEFAULT_DEMO_IMAGE},
                    },
                    {"type": "text", "text": question or DEFAULT_QUESTION},
                ],
            }
        ],
    }
    body_bytes = json.dumps(body).encode("utf-8")
    headers = {
        "Authorization": "Bearer " + api_key,
        "Content-Type": "application/json",
    }
    # R2-EDM-02：禁用 urlopen 的自动重定向，改为手动逐跳处理——每一跳都重新走
    # resolve_public_ip 校验 + 固定 IP 直连，且受 MAX_REDIRECTS 上限约束；
    # 任一跳校验失败或超过跳数上限即 fail-closed 拒绝，杜绝 302 跳内网。
    # P1（2026-08-19 审计）：跨 host 重定向剥离 Authorization——凭据
    # （Bearer api_key）不得转发给重定向目标（CDN/预签名域名，或被劫持后的
    # 任意第三方 host），否则 API Key 原样泄漏（RFC 7235 / OWASP 同款要求）。
    current_url = url
    status = None
    raw = None
    for _hop in range(MAX_REDIRECTS + 1):
        try:
            status, resp_headers, data = _pinned_request(
                current_url, "POST", headers, body_bytes, timeout=60
            )
        except _OutboundBlocked as e:
            return {
                "ok": False,
                "backend": "ark",
                "model": model,
                "error": f"出站地址不安全（{e.reason}）：重定向或 base_url 指向非公网地址。",
                "answer": "",
            }
        except Exception as e:  # 网络/超时等
            return {"ok": False, "backend": "ark", "model": model, "error": str(e), "answer": ""}
        if status in (301, 302, 303, 307, 308):
            location = resp_headers.get("Location")
            if not location:
                return {
                    "ok": False,
                    "backend": "ark",
                    "model": model,
                    "error": f"HTTP {status} 重定向缺少 Location。",
                    "answer": "",
                }
            next_url = urljoin(current_url, location)
            if urlparse(next_url).netloc != urlparse(current_url).netloc:
                headers = {
                    k: v for k, v in headers.items() if k.lower() != "authorization"
                }
            current_url = next_url
            continue
        raw = data.decode("utf-8", "replace")
        break
    else:
        return {
            "ok": False,
            "backend": "ark",
            "model": model,
            "error": f"重定向超过 {MAX_REDIRECTS} 跳上限，已拒绝。",
            "answer": "",
        }
    if status is None or status >= 400:
        detail = (raw or "")[:500]
        return {
            "ok": False,
            "backend": "ark",
            "model": model,
            "error": f"HTTP {status}: {detail}",
            "answer": "",
        }

    try:
        text = _extract_content(raw)
    except Exception as e:
        return {"ok": False, "backend": "ark", "model": model, "error": f"解析响应失败: {e}", "answer": ""}
    if not text:
        return {"ok": False, "backend": "ark", "model": model, "error": "模型未返回文本内容。", "answer": ""}
    return {"ok": True, "backend": "ark", "model": model, "answer": text}
