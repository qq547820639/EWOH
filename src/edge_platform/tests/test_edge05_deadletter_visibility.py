"""EDGE-05 重裁决（V96）：四处死信各自的"可见性"与"可 drain 性"（真起边缘网关 HTTP）。

登记原文：「三处死信（`frame_dead_letter` 表、回执 `*.dead-letter.jsonl`、上行 `*.dead-letter.jsonl`）
**无自动 drain、无主动告警**，仅 `logger` + health 计数」。本轮逐处量：

  · 帧死信（SQLite `frame_dead_letter`）：`GET /api/status` 有 `frame_dead_letters` 计数，
    `storage.list_frame_dead_letters()` 存在但只有测试在用 ⇒ 有指标、有读接口、无 drain；
  · 事件上行 / 传感器上行两处 `*.dead-letter.jsonl`：`stats.dead_lettered` / `stats.rejected`
    经 `event_uplink` / `sensor_uplink` 子对象进 `/api/status`（未配置时如实 `enabled:false` 且无计数）
    ⇒ 有指标，**没有任何读取方的 drain**；
  · 回执 journal 的 `*.dead-letter.jsonl`（FR8/V94 那条）：计数器 `receipt_retry_dropped` /
    `receipt_retry_rejected` **只在 control_downlink.py 内部自增**，`ControlAgent` 根本不在
    边缘网关的 status 面里 ⇒ 这四处里唯一"连一个槽位都没有"的一处。

DL-01/DL-02 是可长期留下的判据；DL-02 标"现状钉住"，
翻案条件：ControlAgent 进 `/api/status`（哪怕只报 `enabled:false`）后，本例应改为断言计数字段存在。
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from _fixtures import _ServerFixture  # noqa: E402
from edge_platform.edge.bridge.control_downlink import (  # noqa: E402
    ControlAgent,
    ControlDownlinkClient,
)
from edge_platform.tests.test_control_downlink import (  # noqa: E402
    _StubPlatform,
    command,
    make_adapter,
)


def _walk_keys(node):
    if isinstance(node, dict):
        for key, value in node.items():
            yield str(key)
            yield from _walk_keys(value)
    elif isinstance(node, list):
        for item in node:
            yield from _walk_keys(item)


class Edge05DeadLetterVisibilityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fx = _ServerFixture(prefix="ewoh_edge05_")

    @classmethod
    def tearDownClass(cls):
        cls.fx.stop()

    def status_payload(self):
        status, _headers, body = self.fx.req("/api/status")
        self.assertEqual(status, 200)
        return body

    def test_dl01_四处死信里三处在_status_有槽位_回执那处没有(self):
        """槽位=计数或显式 enabled:false（未配置时如实上报），不是"必须看到数字"。"""
        payload = self.status_payload()
        slots = {
            "帧死信 frame_dead_letter": "frame_dead_letters" in payload,
            "事件上行 event_uplink": isinstance(payload.get("event_uplink"), dict),
            "传感器上行 sensor_uplink": isinstance(payload.get("sensor_uplink"), dict),
        }
        print(f"[V96] DL-01 /api/status 死信槽位 {json.dumps(slots, ensure_ascii=False)} "
              f"event_uplink={json.dumps(payload.get('event_uplink'), ensure_ascii=False)[:120]}")
        self.assertTrue(all(slots.values()), f"死信槽位回归：{slots}")
        # 未配置时也必须"有槽位且如实为 false"，而不是整块消失
        for key in ("event_uplink", "sensor_uplink"):
            block = payload[key]
            self.assertTrue(block.get("enabled") is False or "stats" in block,
                            f"{key} 既没有 enabled:false 也没有 stats ⇒ 健康页在替存储说谎")

        keys = set(_walk_keys(payload))
        receipt_side = [k for k in keys if "receipt" in str(k).lower() or "control_agent" in str(k).lower()]
        self.assertEqual([], receipt_side, "回执 journal 这一处在 /api/status 里连槽位都没有（现状钉住）")

    def test_dl01b_事件上行死信既有计数也落文件(self):
        """组件级：证明上行那处的"指标槽"是真有数据的，不是空壳。"""
        from edge_platform.edge.bridge.event_uplink import EventUplink

        queue = tempfile.NamedTemporaryFile(prefix="edge05-uplink-", suffix=".jsonl", delete=False)
        queue.close()
        dead = f"{queue.name}.dead-letter.jsonl"
        for path in (queue.name, dead):
            self.addCleanup(lambda p=path: os.path.exists(p) and os.unlink(p))

        uplink = EventUplink(None, "http://127.0.0.1:1", ingest_key="k", queue_path=queue.name)
        before = int(uplink.health()["stats"].get("dead_lettered", 0))
        uplink._dead_letter([{"event_id": "EVT-edge05", "kind": "probe"}], "测试注入：毒信封")
        health = uplink.health()
        after = int(health["stats"].get("dead_lettered", 0))
        print(f"[V96] DL-01b event_uplink.stats.dead_lettered {before} → {after}；"
              f"queue_path 在 health 里={health.get('queue_path') is not None}")
        self.assertEqual(after, before + 1, "死信计数必须随一次转死信 +1")
        self.assertTrue(os.path.exists(dead), "转死信必须落文件（人工重放载体的存在形式）")
        self.assertEqual(json.loads(open(dead, encoding="utf-8").readline())["event_id"], "EVT-edge05")

    def test_dl02_制造一条回执死信后_status_仍然看不见(self):
        """真跑一次"确定性 4xx 拒绝 ⇒ 转入 *.dead-letter.jsonl"，再看边缘网关 status 有没有变化。"""
        journal = tempfile.NamedTemporaryFile(prefix="edge05-receipt-", suffix=".jsonl", delete=False)
        journal.close()
        dead_letter = f"{journal.name}.dead-letter.jsonl"
        for path in (journal.name, dead_letter):
            self.addCleanup(lambda p=path: os.path.exists(p) and os.unlink(p))

        platform = _StubPlatform([command()])
        try:
            adapter, _transport = make_adapter()
            client = ControlDownlinkClient(platform.url, "k")
            agent = ControlAgent(client, {"AGV-01": adapter}, receipt_journal_path=journal.name)
            client.receipt = lambda *a, **kw: (400, {"error": "receipt_invalid"})
            first = agent.run_once("AGV-01")
            self.assertEqual(first["outcomes"][0]["receiptStatus"], 400)

            # 第二轮：journal 载入 → 仍是 400 → 转入持久死信文件并计数
            restarted = ControlAgent(client, {"AGV-01": adapter}, receipt_journal_path=journal.name)
            second = restarted.run_once("AGV-01")
            self.assertEqual(second["receiptRetryFlushed"], 0)
            self.assertGreaterEqual(restarted.receipt_retry_rejected, 1)
            self.assertTrue(os.path.exists(dead_letter), "死信文件确实落了")
            written = [json.loads(line) for line in open(dead_letter, encoding="utf-8") if line.strip()]
            self.assertEqual([w["commandId"] for w in written], ["att-1"])

            payload = self.status_payload()
            self.assertNotIn("receipt_retry_rejected", json.dumps(payload),
                            "边缘网关 status 不看 ControlAgent ⇒ 这条死信对运维完全不可见")
            self.assertNotIn("att-1", json.dumps(payload, ensure_ascii=False))
        finally:
            platform.stop()


if __name__ == "__main__":
    unittest.main()
