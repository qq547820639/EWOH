"""EDGE-01 关停协议断言：凡启动的后台消费者必须被停止，且按启动反序。

真实装配（`edge_platform.run.main`）+ 替身消费者：替身记录 start/stop 次序，
`server.build_server` 被换成「立即结束 serve_forever」的假句柄，从而完整跑一遍启动→关停。
这条不变量此前无任何测试覆盖（走读发现：`run.py` 的 finally 只停 simulator 与 manager，
四类上行/投影消费者虽各自有 stop() 却从未被调用）。

探针必须跑在**子进程**里：`main()` 会向进程级注册表写入调度钩子等全局状态，
在同进程内执行会改变后续路由用例的行为（实测：`test_server_routes_characterization`
的 POST /tasks confirm 两例因此转红）。故本文件把装配放进了 `--probe` 子进程。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import ExitStack
from unittest.mock import patch

SRC_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PROBE_ENV = {
    "EWOH_RUNTIME_MODE": "simulation",
    "EWOH_EVENT_UPLINK_URL": "http://127.0.0.1:1",
    "EWOH_SENSOR_UPLINK_URL": "http://127.0.0.1:1",
    "EWOH_METRICS_UPLINK_URL": "http://127.0.0.1:1",
    "EWOH_WORLD_TENANT_ID": "t-shutdown",
    "EWOH_WORLD_FACTORY_ID": "f-shutdown",
    "EWOH_WORLD_KIND_MAP": '{"telemetry":"device"}',
}

STARTS = []
STOPS = []
FAIL_STOP_NAMES = set()


class _RecordingConsumer:
    """后台消费者替身：start/stop 记入共享序列，可按名字注入「停止时抛错」。"""

    def __init__(self, name, *args, **kwargs):
        self.name = name
        self.enabled = True
        self._started = False

    def start(self):
        self._started = True
        STARTS.append(self.name)

    def stop(self):
        assert self._started, f"{self.name} 未启动却被停止"
        if self.name in FAIL_STOP_NAMES:
            raise RuntimeError(f"{self.name} 停止失败（测试注入）")
        STOPS.append(self.name)


class _FakeHttpd:
    def serve_forever(self):
        raise KeyboardInterrupt

    def shutdown(self):
        return None


def _factory(name):
    return lambda *args, **kwargs: _RecordingConsumer(name, *args, **kwargs)


def run_probe():
    """在干净进程里执行真实装配，返回 (启动序列, 停止序列)。"""
    from edge_platform import run as run_module
    from edge_platform.edge.bridge import event_uplink as event_uplink_mod
    from edge_platform.edge.bridge import metrics_uplink as metrics_uplink_mod
    from edge_platform.edge.bridge import sensor_uplink as sensor_uplink_mod
    from edge_platform.world_model import projection as projection_mod

    workdir = tempfile.mkdtemp(prefix="ewoh-shutdown-")
    db_path = os.path.join(workdir, "edge.db")
    os.environ.update(PROBE_ENV)
    saved_argv = list(sys.argv)
    sys.argv = ["run.py", "--db", db_path, "--port", "0"]
    try:
        with ExitStack() as stack:
            stack.enter_context(
                patch.object(run_module.server, "build_server", lambda *a, **k: _FakeHttpd())
            )
            stack.enter_context(patch.object(event_uplink_mod, "EventUplink", _factory("event")))
            stack.enter_context(
                patch.object(sensor_uplink_mod, "SensorUplinkBridge", _factory("sensor"))
            )
            stack.enter_context(patch.object(metrics_uplink_mod, "MetricsUplink", _factory("metrics")))
            stack.enter_context(
                patch.object(projection_mod, "TelemetryWorldProjector", _factory("projection"))
            )
            run_module.main()
    finally:
        sys.argv = saved_argv
        shutil.rmtree(workdir, ignore_errors=True)
    return list(STARTS), list(STOPS)


class RunShutdownProtocolTest(unittest.TestCase):
    def _probe(self, fail_stop=None):
        cmd = [sys.executable, os.path.abspath(__file__), "--probe"]
        if fail_stop:
            cmd += ["--fail-stop", fail_stop]
        env = dict(os.environ, PYTHONPATH=SRC_ROOT, PYTHONDONTWRITEBYTECODE="1")
        result = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=180)
        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
        payload = json.loads(result.stdout.strip().splitlines()[-1])
        return payload["starts"], payload["stops"]

    def test_every_started_consumer_is_stopped(self):
        starts, stops = self._probe()
        self.assertTrue(starts, "装配未启动任何后台消费者，测试前提失效")
        self.assertEqual(sorted(starts), sorted(stops))

    def test_stops_happen_in_reverse_start_order(self):
        starts, stops = self._probe()
        self.assertEqual(stops, list(reversed(starts)))

    def test_one_failing_stop_does_not_block_the_rest(self):
        starts, stops = self._probe(fail_stop="event")
        self.assertIn("event", starts)
        self.assertNotIn("event", stops)  # 自身抛错被显式记录，不静默吞
        for name in starts:
            if name != "event":
                self.assertIn(name, stops)


if __name__ == "__main__":
    argv = sys.argv[1:]
    if "--probe" in argv:
        if "--fail-stop" in argv:
            FAIL_STOP_NAMES.add(argv[argv.index("--fail-stop") + 1])
        starts, stops = run_probe()
        print(json.dumps({"starts": starts, "stops": stops}))
    else:
        unittest.main()
