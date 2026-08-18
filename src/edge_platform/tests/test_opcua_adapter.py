"""OPC-UA 连接器测试（2026-08-19 审计 P1 回归）。

覆盖：收件箱满时 _enqueue_raw 走 except queue.Full 路径不再
AttributeError（_dropped_points 此前漏初始化，队列第一次满即崩溃
采集线程）；丢弃计数与留痕语义（对齐 modbus EDGE-219 模式）。
"""

import os
import queue
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.connectors.opcua import OpcUaAdapter


def _datapoint(node_id="ns=2;s=Temp.1", value=23.5):
    return {"nodeId": node_id, "value": value, "metricName": "temperature"}


class OpcUaAdapterTest(unittest.TestCase):
    def test_inbox_full_no_attribute_error(self):
        """P1 回归：收件箱满首次触发不再 AttributeError（崩溃采集线程）。"""
        adapter = OpcUaAdapter("OPC-001", "opc.tcp://127.0.0.1:4840")
        adapter._inbox = queue.Queue(maxsize=1)
        adapter._inbox.put(_datapoint())
        # 第二条触发 queue.Full → 修复前此处 AttributeError
        adapter._enqueue_raw(_datapoint(node_id="ns=2;s=Temp.2"))
        self.assertEqual(adapter._dropped_points, 1)

    def test_dropped_points_initialized_zero(self):
        adapter = OpcUaAdapter("OPC-002", "opc.tcp://127.0.0.1:4840")
        self.assertEqual(adapter._dropped_points, 0)


if __name__ == "__main__":
    unittest.main()
