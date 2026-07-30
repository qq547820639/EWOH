# EWOH 平台层：数据源切换、回放导出、九页 API、任务推荐、本地助手、场景评估、演示闭环
import os as _os
import sys as _sys

# 使 edge / inference / collection 等子包可作为顶层包导入
# （run.py 契约：from edge.storage import Storage / from inference.pipeline import ...）
_PKG_DIR = _os.path.dirname(_os.path.abspath(__file__))
if _PKG_DIR not in _sys.path:
    _sys.path.insert(0, _PKG_DIR)
