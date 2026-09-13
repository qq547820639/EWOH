#!/usr/bin/env python3
"""Run the local device-fault recovery scenario and save its execution evidence."""

import argparse
import json
import os
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from edge_platform.scenario.closed_loop import run_closed_loop


def main():
    parser = argparse.ArgumentParser(description="异常感知到执行反馈的本地模拟闭环；不连接真实设备")
    parser.add_argument("--output", type=Path, default=Path("output/closed-loop-evidence.json"))
    parser.add_argument("--serve", action="store_true", help="完成后保持本地模拟工厂运行，供浏览器交互")
    args = parser.parse_args()
    os.environ["EWOH_RUNTIME_MODE"] = "simulation"
    def save(result):
        args.output.parent.mkdir(parents=True, exist_ok=True)
        serialized = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        args.output.write_text(serialized, encoding="utf-8")

    def serve(base_url, result):
        save(result)
        print(f"本地模拟 API：{base_url}/api/scheduling/plans（全部数据 simulated；Ctrl-C 停止）", flush=True)
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            pass

    result = run_closed_loop(on_ready=serve if args.serve else None)
    save(result)
    print(f"模拟闭环已通过：{len(result['operations'])} 次 HTTP 操作；证据：{args.output.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
