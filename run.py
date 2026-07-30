#!/usr/bin/env python3
"""EWOH 平台零配置启动入口。

从仓库根目录直接运行即可，无需 make 或 PYTHONPATH：

    python run.py [--host 127.0.0.1] [--port 8765] [--stub]

等价于 `make run` / `PYTHONPATH=src python -m edge_platform.run`。
"""
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from edge_platform.run import main

if __name__ == "__main__":
    main()
