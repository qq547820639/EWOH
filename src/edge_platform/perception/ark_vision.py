"""Ark 视觉理解接入（演示模式默认视觉理解后端）。

对应分享中的默认调用方式：调用火山方舟视觉模型，对输入图片返回自然语言描述
（默认提问"你看见了什么？"）。演示场景未显式传入图片时，默认使用官方案例图。

- 纯标准库实现（urllib），零第三方依赖；
- 配置经 Settings 从环境变量读取：EWOH_ARK_API_KEY / EWOH_ARK_BASE_URL / EWOH_ARK_MODEL；
- 未配置 API Key 时返回明确的结构化错误，绝不伪造描述。

说明：分享中的示例使用 `/responses` + `input_image` 类型，经实测该模型不支持该类型；
本项目改用标准 Chat Completions（`/chat/completions` + `image_url`）完成同样的视觉理解。
"""

import contextlib
import json
import urllib.error
import urllib.request

from edge_platform.config import Settings

DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"
DEFAULT_MODEL = "doubao-seed-2-1-pro-260628"
DEFAULT_QUESTION = "你看见了什么？"
#: 演示模式默认图片（未显式传入 image_url 时使用）
DEFAULT_DEMO_IMAGE = "https://ark-project.tos-cn-beijing.volces.com/doc_image/ark_demo_img_1.png"


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


def describe_image(image_url="", question=DEFAULT_QUESTION):
    """调用 Ark 视觉模型描述图片。

    :param image_url: 图片地址；为空时使用演示模式默认图。
    :param question:  提问文本，默认为"你看见了什么？"。
    :return: dict，含 ok/backend/model/answer；失败时含 error。
    """
    s = Settings.load()
    api_key = getattr(s, "ark_api_key", "") or ""
    base_url = getattr(s, "ark_base_url", "") or DEFAULT_BASE_URL
    model = getattr(s, "ark_model", "") or DEFAULT_MODEL
    if not api_key:
        return {
            "ok": False,
            "backend": "ark",
            "model": model,
            "error": "未配置 EWOH_ARK_API_KEY，无法调用视觉理解模型。",
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
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": "Bearer " + api_key,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        detail = ""
        with contextlib.suppress(Exception):
            detail = e.read().decode("utf-8", "replace")[:500]
        return {"ok": False, "backend": "ark", "model": model, "error": f"HTTP {e.code}: {detail}", "answer": ""}
    except Exception as e:  # 网络/超时等
        return {"ok": False, "backend": "ark", "model": model, "error": str(e), "answer": ""}

    try:
        text = _extract_content(raw)
    except Exception as e:
        return {"ok": False, "backend": "ark", "model": model, "error": f"解析响应失败: {e}", "answer": ""}
    if not text:
        return {"ok": False, "backend": "ark", "model": model, "error": "模型未返回文本内容。", "answer": ""}
    return {"ok": True, "backend": "ark", "model": model, "answer": text}