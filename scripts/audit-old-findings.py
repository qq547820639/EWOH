#!/usr/bin/env python3
"""audit-old-findings.py — 解析第一轮逐行审计 §6 清单 + 汇聚回归验证结果.

用法:
  python3 scripts/audit-old-findings.py parse            # 解析 docs/audit/2026-08-17-line-by-line-audit.md -> parts/old-findings-<prefix>.jsonl
  python3 scripts/audit-old-findings.py aggregate        # 汇聚 parts/regression-*.jsonl -> old-finding-regression.yaml（含终态统计）
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AUDIT = ROOT / "docs/audit/2026-08-17-line-by-line-audit.md"
CURRENT = ROOT / "docs/audit/current"
PARTS = CURRENT / "parts"

SEV_MAP = {"C": "Critical", "H": "High", "M": "Medium", "L": "Low"}


def cmd_parse() -> None:
    text = AUDIT.read_text(encoding="utf-8")
    # §6 各小节代码块内: ID|严重度|位置|问题|建议
    rows = []
    for m in re.finditer(r"^([A-Z]{2,5}-\d+)\|([CHML])\|([^|]+)\|([^|]+)\|(.+?)\s*$", text, re.M):
        fid, sev, loc, problem, advice = [x.strip() for x in m.groups()]
        prefix = fid.split("-")[0]
        rows.append({
            "id": fid, "severity": SEV_MAP[sev], "location": loc,
            "problem": problem, "recommended_fix": advice, "prefix": prefix,
        })
    PARTS.mkdir(parents=True, exist_ok=True)
    by_prefix: dict[str, list] = {}
    for r in rows:
        by_prefix.setdefault(r["prefix"], []).append(r)
    for prefix, items in sorted(by_prefix.items()):
        out = PARTS / f"old-findings-{prefix.lower()}.jsonl"
        out.write_text("".join(json.dumps(i, ensure_ascii=False) + "\n" for i in items), encoding="utf-8")
        sev = Counter(i["severity"] for i in items)
        print(f"{prefix}: {len(items)} ({dict(sev)}) -> {out.relative_to(ROOT)}")
    print(f"total parsed: {len(rows)}")


def cmd_aggregate() -> None:
    entries: dict[str, dict] = {}
    for f in sorted(PARTS.glob("old-findings-*.jsonl")):
        for line in f.read_text(encoding="utf-8").splitlines():
            if line.strip():
                j = json.loads(line)
                entries[j["id"]] = {**j, "regression_status": "UNVERIFIED"}
    def norm(s: str) -> str:
        s = (s or "").upper()
        if s.startswith("FIXED") or s == "VERIFIED_FIXED":
            return "FIXED_VERIFIED"
        if s.startswith("PARTIAL"):
            return "PARTIALLY_FIXED"
        if s in ("STILL_PRESENT", "STILL_OPEN", "NOT_FIXED"):
            return "STILL_PRESENT"
        if s.startswith("NO_LONGER"):
            return "NO_LONGER_APPLICABLE"
        if s in ("ACKNOWLEDGED", "WONTFIX_ACCEPTED", "NOT_FIXED_ACCEPTED_RISK", "DOCUMENTED", "DOCUMENTED_LEGACY"):
            return "DOCUMENTED_RULING"
        if s in ("OUT_OF_SCOPE", "INFO"):
            return "UNVERIFIED"
        return s if s in ("FIXED_VERIFIED", "PARTIALLY_FIXED", "REGRESSED", "UNVERIFIED", "STILL_PRESENT", "NO_LONGER_APPLICABLE", "DOCUMENTED_RULING") else "UNVERIFIED"

    for f in sorted(CURRENT.glob("regression-*.jsonl")):
        for line in f.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            j = json.loads(line)
            j["regression_status"] = norm(j.get("regression_status"))
            if j.get("id") in entries:
                entries[j["id"]].update({k: v for k, v in j.items() if k != "id"})
    lines = [
        "# old-finding-regression.yaml — 第一轮 950 项发现回归验证（HEAD 58b7819e）",
        f"# generated_at: {datetime.now(timezone.utc).isoformat()}",
        f"# total: {len(entries)}",
        "",
    ]
    stat = Counter(e.get("regression_status", "UNVERIFIED") for e in entries.values())
    for k in ["FIXED_VERIFIED", "STILL_PRESENT", "PARTIALLY_FIXED", "REGRESSED", "NO_LONGER_APPLICABLE", "DOCUMENTED_RULING", "UNVERIFIED"]:
        if stat.get(k):
            lines.append(f"# {k}: {stat[k]}")
    lines.append("findings:")
    by_sev: dict[str, list] = {}
    for e in entries.values():
        by_sev.setdefault(e["severity"], []).append(e)
    for sev in ["Critical", "High", "Medium", "Low"]:
        for e in sorted(by_sev.get(sev, []), key=lambda x: x["id"]):
            lines.append(f"- id: {e['id']}")
            lines.append(f"  severity: {sev}")
            lines.append(f"  location: {json.dumps(e['location'], ensure_ascii=False)}")
            lines.append(f"  problem: {json.dumps(e['problem'], ensure_ascii=False)}")
            lines.append(f"  regression_status: {e.get('regression_status', 'UNVERIFIED')}")
            ev = e.get("evidence", "")
            lines.append(f"  evidence: {json.dumps(str(ev)[:600], ensure_ascii=False)}")
            if e.get("new_finding_id"):
                lines.append(f"  new_finding_id: {e['new_finding_id']}")
            lines.append("")
    out = CURRENT / "old-finding-regression.yaml"
    out.write_text("\n".join(lines), encoding="utf-8")
    unverified = stat.get("UNVERIFIED", 0)
    print(f"aggregate -> {out.relative_to(ROOT)}; {dict(stat)}")
    if unverified:
        sys.exit(1)


if __name__ == "__main__":
    {"parse": cmd_parse, "aggregate": cmd_aggregate}[sys.argv[1]]()
