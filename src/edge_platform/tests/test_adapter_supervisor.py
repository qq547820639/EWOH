"""Task 13.2 AdapterManager 监督（supervision）故障注入测试。

覆盖：
- (a) 传感器断连：read_message 抛 BaseException（模拟读取线程崩溃）→ 线程真实死亡，
      监督线程检测到后按指数退避自动 respawn；respawns 计数递增、线程列表不无界增长；
      恢复后 health 回到 online。
- (b) 适配器启动崩溃：adapter.start() 前 N 次抛异常后成功 → 监督按退避重试，
      最终 healthy；start 持续失败超过阈值 → health 标记 degraded 且持续重试。
- (c) health() 包含新监督字段（respawns / last_respawn_at / start_failures /
      last_error / supervised）；崩溃后恢复的适配器返回 online。

纯 Python 标准库 unittest；运行：
  PYTHONPATH=src python -m unittest edge_platform.tests.test_adapter_supervisor -v
"""

import os
import sys
import time
import unittest

# 支持 PYTHONPATH=src 与直接运行两种方式
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.edge.adapters.base import BaseAdapter  # noqa: E402
from edge_platform.edge.manager import AdapterManager  # noqa: E402

# pytest 下抑制「线程未处理异常」告警：本文件故障注入刻意让读取线程真实崩溃
# （_ReadCrash 逃逸 _read_loop 的 except Exception，线程死亡由监督线程 respawn）。
# unittest 运行时不依赖 pytest。
try:
    import pytest  # noqa: E402

    pytestmark = pytest.mark.filterwarnings("ignore::pytest.PytestUnhandledThreadExceptionWarning")
except ImportError:  # pragma: no cover - unittest 运行路径
    pytestmark = None


class _ReadCrash(BaseException):
    """模拟读取线程崩溃：BaseException 子类，逃逸 _read_loop 的 except Exception。"""


class _FaultAdapter(BaseAdapter):
    """可配置故障的测试适配器。

    - ``crash_reads``：前 N 次 read_message 抛 _ReadCrash（线程真实崩溃）；
    - ``fail_starts``：前 N 次 start() 抛 RuntimeError（启动失败）。
    """

    def __init__(self, device_id, crash_reads=0, fail_starts=0):
        super().__init__(device_id, source_type="simulated")
        self.crash_reads = crash_reads
        self.fail_starts = fail_starts
        self.start_calls = 0
        self.stop_calls = 0
        self.read_calls = 0
        self._running = False

    def start(self):
        self.start_calls += 1
        if self.start_calls <= self.fail_starts:
            raise RuntimeError(f"start fail #{self.start_calls}")
        self._running = True
        self._started_at = time.time()

    def stop(self):
        self.stop_calls += 1
        self._running = False

    def health(self):
        return {
            "device_id": self.device_id,
            "status": "online" if self._running else "offline",
            "type": "fault",
            "source_type": self.source_type,
        }

    def device_info(self):
        return {"device_id": self.device_id, "type": "fault"}

    def read_message(self, timeout=None):
        if not self._running:
            raise RuntimeError("adapter not started")
        self.read_calls += 1
        if self.read_calls <= self.crash_reads:
            raise _ReadCrash("simulated read crash")
        time.sleep(0.005)
        return None


class _FakeStorage:
    def insert_telemetry(self, row):
        pass


class _FakeBus:
    def publish(self, stream, msg):
        pass


def _wait_until(cond, timeout=5.0, interval=0.01):
    """轮询等待条件成立（返回 bool）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if cond():
            return True
        time.sleep(interval)
    return False


def _make_manager(**kwargs):
    """快速监督参数的管理器（缩短退避/周期，保证测试速度）。"""
    params = dict(
        supervisor_interval=0.05,
        respawn_backoff_base=0.05,
        respawn_backoff_cap=0.5,
        start_failure_degraded_threshold=3,
    )
    params.update(kwargs)
    return AdapterManager(_FakeStorage(), _FakeBus(), **params)


class AdapterSupervisorTest(unittest.TestCase):
    def setUp(self):
        self.manager = _make_manager()

    def tearDown(self):
        try:
            self.manager.stop()
        except Exception:
            pass

    def _health(self, device_id):
        for h in self.manager.health():
            if h.get("device_id") == device_id:
                return h
        raise AssertionError(f"health 中找不到 adapter: {device_id}")

    # ---- (a) 传感器断连：读取线程崩溃 → respawn ----
    def test_sensor_disconnect_respawn_and_recover(self):
        adapter = _FaultAdapter("EXO-DISC-1", crash_reads=3)
        self.manager.register(adapter)
        self.manager.start()

        # 崩溃阶段：线程反复死亡，监督按退避 respawn，期间 health 应标记 degraded/offline
        seen = set()
        deadline = time.time() + 5.0
        while time.time() < deadline:
            h = self._health("EXO-DISC-1")
            seen.add(h["status"])
            if self.manager._supervision[adapter]["respawns"] >= 3:
                break
            time.sleep(0.005)
        self.assertTrue(seen & {"degraded", "offline"}, f"崩溃期间应出现 degraded/offline，实际 {seen}")
        self.assertGreaterEqual(self.manager._supervision[adapter]["respawns"], 3)

        # 崩溃预算耗尽 → 线程存活 → health 恢复 online
        self.assertTrue(
            _wait_until(
                lambda: self.manager._supervision[adapter]["respawns"] == 3
                and self._health("EXO-DISC-1")["status"] == "online"
            ),
            "崩溃恢复后应回到 online",
        )
        # 线程真实死亡过（respawns>0），且没有无界增长：始终只有一个读取线程
        self.assertEqual(len(self.manager._threads), 1)
        # 恢复后计数稳定，不再增长
        self.assertEqual(self.manager._supervision[adapter]["respawns"], 3)
        time.sleep(0.2)
        self.assertEqual(self.manager._supervision[adapter]["respawns"], 3)

    def test_repeated_crash_no_unbounded_thread_growth(self):
        adapter = _FaultAdapter("EXO-DISC-2", crash_reads=10**9)  # 永远崩溃
        self.manager.register(adapter)
        self.manager.start()

        self.assertTrue(
            _wait_until(lambda: self.manager._supervision[adapter]["respawns"] >= 4),
            "监督应持续 respawn",
        )
        # 无界增长的防线：线程被替换而不是累积
        self.assertEqual(len(self.manager._threads), 1)
        thread = self.manager._supervision[adapter]["thread"]
        self.assertIsNotNone(thread)
        # 退避窗口在 respawn 后被设置（间隔至少 respawn_backoff_base）
        sup = self.manager._supervision[adapter]
        self.assertGreater(sup["next_attempt_at"], 0.0)
        # 崩溃期间 health 稳定标记 degraded（start 已成功，线程死亡）
        self.assertEqual(self._health("EXO-DISC-2")["status"], "degraded")
        self.assertGreaterEqual(self._health("EXO-DISC-2")["respawns"], 4)

    # ---- (b) 适配器启动崩溃：start 失败重试 + degraded 阈值 ----
    def test_start_failure_then_success_eventually_healthy(self):
        adapter = _FaultAdapter("EXO-START-1", fail_starts=2)
        self.manager.register(adapter)
        self.manager.start()

        # 第 1 次 start 在 manager.start() 中失败，监督按退避重试直到成功
        self.assertTrue(
            _wait_until(lambda: self._health("EXO-START-1")["status"] == "online"),
            "start 失败重试后应最终 online",
        )
        self.assertGreaterEqual(adapter.start_calls, 3)
        h = self._health("EXO-START-1")
        self.assertEqual(h["start_failures"], 0)
        self.assertEqual(h["respawns"], 0)
        self.assertTrue(h["supervised"])

    def test_start_always_fails_marks_degraded_and_keeps_retrying(self):
        adapter = _FaultAdapter("EXO-START-2", fail_starts=10**9)
        self.manager.register(adapter)
        self.manager.start()

        self.assertTrue(
            _wait_until(lambda: self._health("EXO-START-2")["status"] == "degraded"),
            "start 反复失败超过阈值应 degraded",
        )
        h = self._health("EXO-START-2")
        self.assertGreaterEqual(h["start_failures"], 3)
        self.assertIn("last_error", h)
        # 保持退避重试（attempts 持续增长）
        attempts_before = self.manager._supervision[adapter]["start_attempts"]
        self.assertTrue(
            _wait_until(
                lambda: self.manager._supervision[adapter]["start_attempts"] > attempts_before,
                timeout=3.0,
            ),
            "degraded 后仍应持续退避重试",
        )

    # ---- (c) health() 监督字段 + 恢复后 online ----
    def test_health_includes_supervision_fields(self):
        adapter = _FaultAdapter("EXO-HLTH-1", crash_reads=1)
        self.manager.register(adapter)
        self.manager.start()

        self.assertTrue(
            _wait_until(
                lambda: self.manager._supervision[adapter]["respawns"] >= 1
                and self._health("EXO-HLTH-1")["status"] == "online"
            ),
            "崩溃一次后 respawn 并恢复 online",
        )
        h = self._health("EXO-HLTH-1")
        for key in ("respawns", "last_respawn_at", "start_failures", "supervised"):
            self.assertIn(key, h, f"health 缺少监督字段 {key}")
        self.assertEqual(h["respawns"], 1)
        self.assertIsNotNone(h["last_respawn_at"])
        self.assertEqual(h["start_failures"], 0)
        self.assertIs(h["supervised"], True)
        self.assertEqual(h["status"], "online")  # 崩溃后恢复 → online

    def test_unstarted_manager_health_passthrough(self):
        # 未 start 的管理器：不注入监督字段，保持既有行为
        adapter = _FaultAdapter("EXO-PASSTHRU-1")
        self.manager.register(adapter)
        h = self._health("EXO-PASSTHRU-1")
        self.assertEqual(h["status"], "offline")
        self.assertNotIn("supervised", h)
        self.assertNotIn("respawns", h)

    def test_stop_stops_supervisor_and_adapter(self):
        adapter = _FaultAdapter("EXO-STOP-1")
        self.manager.register(adapter)
        self.manager.start()
        self.assertTrue(
            _wait_until(lambda: self.manager._supervision[adapter]["thread"] is not None),
            "start 后应存在读取线程",
        )
        self.manager.stop()
        self.assertGreaterEqual(adapter.stop_calls, 1)
        self.assertFalse(self.manager._running)
        sup = self.manager._supervisor_thread
        self.assertTrue(sup is None or not sup.is_alive(), "监督线程应已停止")
        self.assertEqual(len(self.manager._threads), 0)


class HealthyAdapterNoInterferenceTest(unittest.TestCase):
    """监督不干预健康线程：respawns 保持 0、线程存活、状态 online。"""

    def test_healthy_thread_untouched(self):
        manager = _make_manager()
        adapter = _FaultAdapter("EXO-OK-1")
        manager.register(adapter)
        manager.start()
        try:
            self.assertTrue(
                _wait_until(lambda: manager._supervision[adapter]["thread"] is not None),
                "start 后应存在读取线程",
            )
            time.sleep(0.3)  # 多个监督周期
            h = manager.health()[0]
            self.assertEqual(h["status"], "online")
            self.assertEqual(h["respawns"], 0)
            self.assertIsNone(h["last_respawn_at"])
            self.assertEqual(h["start_failures"], 0)
            self.assertEqual(len(manager._threads), 1)
            self.assertTrue(manager._supervision[adapter]["thread"].is_alive())
        finally:
            manager.stop()


if __name__ == "__main__":
    unittest.main()
