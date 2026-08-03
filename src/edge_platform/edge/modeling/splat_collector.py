#!/usr/bin/env python3
"""splat_collector.py — 3D Gaussian Splatting (3DGS) 采集指引。

对应 spec §5.2「场景直接建模 — L2 三维 + 多源融合接入」。

工作流
------
1. 按工位/区域规划拍摄路径，采集 RGB 照片序列（建议 50-200 张，覆盖全角度）
2. 使用 COLMAP 进行 SfM（Structure from Motion）稀疏重建，得到相机位姿
3. 训练 3DGS 模型（如 gaussian-splatting），产出 .splat/.ply 文件
4. 将产物上传到对象存储，获取 splat_url
5. 调用 spark-app /api/ingest/spatial-scan 注册扫描产物

本脚本提供采集规划与产物注册的编排框架，实际训练任务需外部 GPU 节点执行。

用法
----
  python splat_collector.py --entity-id WS-001 --output-dir ./scans/ws001
  python splat_collector.py --register --entity-id WS-001 --splat-url https://... --spark-url http://localhost:3000
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from typing import Any
from urllib import error as urllib_error
from urllib import request as urllib_request


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def plan_capture_route(entity_id: str, output_dir: str) -> dict[str, Any]:
    """规划拍摄路径，生成采集清单。

    返回采集清单 dict，包含建议拍摄点数、角度、路径文件路径。
    """
    os.makedirs(output_dir, exist_ok=True)
    plan = {
        "entity_id": entity_id,
        "planned_at": now_iso(),
        "suggested_captures": 120,
        "suggested_angles": ["front", "back", "left", "right", "top", "bottom"],
        "suggested_overlap_pct": 70,
        "output_dir": output_dir,
    }
    plan_path = os.path.join(output_dir, "capture_plan.json")
    with open(plan_path, "w") as f:
        json.dump(plan, f, indent=2, ensure_ascii=False)
    print(f"[splat] 采集清单已生成: {plan_path}")
    print(f"[splat] 建议拍摄 {plan['suggested_captures']} 张，覆盖 {len(plan['suggested_angles'])} 个角度")
    return plan


def register_splat(
    entity_id: str,
    splat_url: str,
    spark_url: str,
    scan_device: str = "manual",
    alignment_error_mm: float = 0.0,
    ingest_key: str = "",
    org_id: str = "",
) -> bool:
    """注册 3DGS 产物到 spark-app。"""
    payload = {
        "entity_id": entity_id,
        "source_type": "gaussian_splat",
        "confidence": 0.95,
        "capture_at": now_iso(),
        "scan_device": scan_device,
        "alignment_error_mm": alignment_error_mm,
        "splat_url": splat_url,
    }
    url = f"{spark_url.rstrip('/')}/api/ingest/spatial-scan"
    body = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if ingest_key:
        headers["X-Ingest-Key"] = ingest_key
    if org_id:
        headers["X-Org-Id"] = org_id
    req = urllib_request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib_request.urlopen(req, timeout=10) as resp:  # nosec B310 - configured internal HTTP client
            if 200 <= resp.status < 300:
                print(f"[splat] 注册成功 entity={entity_id}")
                return True
            print(f"[splat] HTTP {resp.status}")
            return False
    except urllib_error.URLError as e:
        print(f"[splat] 注册失败: {e}")
        return False


def main():
    parser = argparse.ArgumentParser(description="3DGS 采集指引与产物注册")
    parser.add_argument("--entity-id", required=True, help="空间实体ID")
    parser.add_argument("--output-dir", default="./scans", help="采集输出目录")
    parser.add_argument("--register", action="store_true", help="注册产物模式")
    parser.add_argument("--splat-url", default="", help="splat 文件 URL（注册模式）")
    parser.add_argument("--spark-url", default="http://localhost:3000", help="spark-app 地址")
    parser.add_argument("--ingest-key", default="", help="Ingestion API Key")
    parser.add_argument("--org-id", default="", help="目标组织 ID")
    parser.add_argument("--scan-device", default="manual", help="扫描设备标识")
    args = parser.parse_args()

    if args.register:
        if not args.splat_url:
            print("[splat] 注册模式需要 --splat-url")
            sys.exit(1)
        ok = register_splat(
            entity_id=args.entity_id,
            splat_url=args.splat_url,
            spark_url=args.spark_url,
            scan_device=args.scan_device,
            ingest_key=args.ingest_key,
            org_id=args.org_id,
        )
        sys.exit(0 if ok else 1)
    else:
        plan_capture_route(args.entity_id, args.output_dir)


if __name__ == "__main__":
    main()
