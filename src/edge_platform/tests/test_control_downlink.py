"""平台命令下行 + 边缘命令代理测试（NO-60a）。

用一个**本地 HTTP 桩平台**（http.server）验证闭环语义：
  1. 正常路径：平台下发 `dispatch_task`（带 payload）→ 代理执行 → ack `delivered` +
     回执 `executed`，且适配器状态真的变了；
  2. **授权号只能由平台签发**：授权号与 requestId 不一致 → 投递拒绝
     （`authorization_ref_mismatch`），**不碰设备**、不回执"已执行"；
  3. 设备故障态 → 网关**已收到**（ack delivered=true）但回执 `failed` + 原因
     （状态机 gateway_received → failed，两件事不混为一谈）；
  4. 平台不可达 → 不改状态、不撒谎（命令留在 sent，下一轮重投）；
  5. 本地没有该设备的适配器 → 不动任何状态（返回 no_local_adapter）；
  6. **NO-62a 授权范围指纹**：平台签发 → 边缘原样回传（ack 与回执两处），
     边缘不自己"重算一个看起来对的"指纹；
  7. **NO-62a 平台复核拒绝投递**（ack 409：审批已失效）→ 不改执行结果、
     不假装投递成功，返回 `delivery_rejected_by_platform`；
  8. **NO-62b 安全动作插队**：平台顺序退化（搬运排在急停前）时，边缘按优先级
     重排执行并上报 `platformOrderViolation`（纵深防御，不静默接受）。
"""

import json
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from edge_platform.edge.adapters.actuator.adapter import ActuatorAdapter  # noqa: E402
from edge_platform.edge.adapters.actuator.protocol import (  # noqa: E402
    authorization_fingerprint,
    authorization_fingerprint_v2,
)
from edge_platform.edge.bridge.control_downlink import (  # noqa: E402
    ControlAgent,
    ControlDownlinkClient,
)


class _StubPlatform:
    """最小平台桩：/pending 返回预置命令，/ack 与 /receipts 记录调用。"""

    def __init__(self, commands, pending_extra=None, ack_status=200):
        self.commands = list(commands)
        self.acks = []
        self.receipts = []
        self.pending_calls = []
        self.ack_status = ack_status
        self.pending_extra = dict(pending_extra or {})
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):  # 静音
                return

            def _read(self):
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length).decode() if length else "{}"
                try:
                    return json.loads(raw or "{}")
                except json.JSONDecodeError:
                    return {}

            def _send(self, status, payload):
                body = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):  # noqa: N802 - http.server 接口
                if self.path.startswith("/api/control/commands/pending"):
                    outer.pending_calls.append(self.path)
                    device = "AGV-01"
                    if "deviceId=" in self.path:
                        device = self.path.split("deviceId=")[1].split("&")[0]
                    device = device.replace("%3A", ":")
                    cmds = [c for c in outer.commands if c.get("deviceId", "AGV-01") == device]
                    self._send(200, {"deviceId": device, "commands": cmds, **outer.pending_extra})
                    return
                self._send(404, {"error": "not found"})

            def do_POST(self):  # noqa: N802
                body = self._read()
                if self.path.startswith("/api/control/commands/") and self.path.endswith("/ack"):
                    command_id = self.path.split("/")[4]
                    outer.acks.append({"commandId": command_id, **body})
                    if outer.ack_status != 200:
                        self._send(
                            outer.ack_status,
                            {"statusCode": outer.ack_status, "message": "投递被拒：授权复核未通过"},
                        )
                        return
                    self._send(200, {"commandId": command_id, "status": "gateway_received", "alreadyAcked": False})
                    return
                if self.path.endswith("/receipt"):
                    command_id = self.path.split("/")[4]
                    outer.receipts.append({"commandId": command_id, **body})
                    self._send(201, {"ok": True})
                    return
                self._send(404, {"error": "not found"})

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


def make_adapter(device_id="AGV-01"):
    adapter = ActuatorAdapter(device_id, source_type="simulated")
    adapter.start()
    transport = adapter.transport
    transport.register_station("ST-1", 2.0, 0.0)
    return adapter, transport


def command(**overrides):
    base = {
        "commandId": "att-1",
        "requestId": "ctl-1",
        "commandKey": "dispatch_task",
        "attemptNo": 1,
        "authorizationRef": "control:ctl-1",
        "payload": {"targetStationId": "ST-1", "taskId": "T-1"},
        "sentAt": "2026-09-12T03:00:00.000Z",
        "orgId": "ORG-1",
    }
    base.update(overrides)
    return base


class ControlDownlinkTest(unittest.TestCase):
    def test_happy_path_executes_and_reports(self):
        platform = _StubPlatform([command()])
        try:
            adapter, transport = make_adapter()
            client = ControlDownlinkClient(platform.url, "k", org_id="ORG-1")
            agent = ControlAgent(client, {"AGV-01": adapter})

            stats = agent.run_once("AGV-01")

            self.assertEqual(stats["polled"], 1)
            outcome = stats["outcomes"][0]
            self.assertEqual(outcome["outcome"], "executed")
            self.assertEqual(outcome["ackStatus"], 200)
            self.assertEqual(outcome["receiptStatus"], 201)
            self.assertEqual(platform.acks[0]["delivered"], True)
            self.assertEqual(platform.receipts[0]["result"], "executed")
            self.assertEqual(platform.receipts[0]["commandKey"], "dispatch_task")
            # 回执走网关命令面（机器身份），不是人面 /requests/:id/receipts
            self.assertEqual(platform.receipts[0]["commandId"], "att-1")
            # 设备真的动了：状态 moving + 目标工位 + 授权号留痕
            self.assertEqual(transport.state.state, "moving")
            self.assertEqual(transport.state.target_station_id, "ST-1")
            self.assertEqual(transport.state.last_authorization_ref, "control:ctl-1")
        finally:
            platform.stop()

    def test_authorization_ref_must_match_request(self):
        platform = _StubPlatform([command(authorizationRef="control:other-request")])
        try:
            adapter, transport = make_adapter()
            agent = ControlAgent(ControlDownlinkClient(platform.url, "k"), {"AGV-01": adapter})

            stats = agent.run_once("AGV-01")

            outcome = stats["outcomes"][0]
            self.assertEqual(outcome["outcome"], "delivery_rejected")
            self.assertEqual(outcome["reason"], "authorization_ref_mismatch")
            self.assertEqual(platform.acks[0]["delivered"], False)
            self.assertEqual(platform.receipts, [])
            # 不碰设备：既不移动也不记授权号
            self.assertEqual(transport.state.state, "idle")
            self.assertIsNone(transport.state.last_authorization_ref)
        finally:
            platform.stop()

    def test_missing_authorization_ref_is_rejected(self):
        platform = _StubPlatform([command(authorizationRef="")])
        try:
            adapter, transport = make_adapter()
            agent = ControlAgent(ControlDownlinkClient(platform.url, "k"), {"AGV-01": adapter})
            stats = agent.run_once("AGV-01")
            self.assertEqual(stats["outcomes"][0]["reason"], "authorization_ref_missing")
            self.assertEqual(transport.state.state, "idle")
        finally:
            platform.stop()

    def test_device_fault_acks_delivered_but_receipt_failed(self):
        platform = _StubPlatform([command()])
        try:
            adapter, transport = make_adapter()
            transport.inject_fault("MOTOR_OVERHEAT")
            agent = ControlAgent(ControlDownlinkClient(platform.url, "k"), {"AGV-01": adapter})

            stats = agent.run_once("AGV-01")

            outcome = stats["outcomes"][0]
            self.assertEqual(outcome["outcome"], "execution_failed")
            self.assertIn("device_fault", str(outcome["adapterReason"]))
            # 网关已收到（投递确认成功），执行失败如实回执
            self.assertEqual(platform.acks[0]["delivered"], True)
            self.assertEqual(platform.receipts[0]["result"], "failed")
            self.assertIn("device_fault", platform.receipts[0]["receipt"]["adapterReason"])
        finally:
            platform.stop()

    def test_platform_unreachable_does_not_lie(self):
        adapter, transport = make_adapter()
        client = ControlDownlinkClient("http://127.0.0.1:1", "k", timeout=0.5)
        agent = ControlAgent(client, {"AGV-01": adapter})

        stats = agent.run_once("AGV-01")

        self.assertEqual(stats["polled"], 0)
        self.assertTrue(str(stats["note"]).startswith("pending_failed"))
        self.assertEqual(transport.state.state, "idle")

    def test_no_local_adapter_does_nothing(self):
        platform = _StubPlatform([command()])
        try:
            agent = ControlAgent(ControlDownlinkClient(platform.url, "k"), {})
            stats = agent.run_once("AGV-99")
            self.assertEqual(stats["note"], "no_local_adapter")
            self.assertEqual(platform.acks, [])
            self.assertEqual(platform.receipts, [])
        finally:
            platform.stop()


class ControlAgentCliTest(unittest.TestCase):
    def test_authorization_fingerprint_is_echoed_not_recomputed(self):
        """NO-62a：指纹由平台签发，边缘**原样回传**（ack 的 details + 回执体）。

        NO-65a：边缘现在会**先核对**这个指纹（v1 一致性 / v2 签名），所以测试必须给一个
        "与授权范围一致"的指纹——否则测的是拒绝路径而不是回传路径。
        """
        # 该指纹按边缘可见的授权范围（无 scope → 用设备号/请求号/命令键/参数）计算。
        valid_v1 = authorization_fingerprint(
            "ctl-1", "AGV-01", "dispatch_task", None,
            {"targetStationId": "ST-1", "taskId": "T-1"},
        )
        platform = _StubPlatform([command(authorizationFingerprint=valid_v1)])
        try:
            adapter, _transport = make_adapter()
            agent = ControlAgent(ControlDownlinkClient(platform.url, "k"), {"AGV-01": adapter})

            stats = agent.run_once("AGV-01")

            self.assertEqual(stats["outcomes"][0]["authorizationFingerprint"], valid_v1)
            self.assertEqual(
                platform.acks[0]["details"]["authorizationFingerprint"], valid_v1
            )
            self.assertEqual(
                platform.receipts[0]["receipt"]["authorizationFingerprint"], valid_v1
            )
            # NO-65a：验签结论必须可区分（v1 一致性核对通过 → verified=True）
            self.assertEqual(platform.acks[0]["details"]["fingerprintScheme"], "fnv1a64:v1")
            self.assertTrue(platform.acks[0]["details"]["fingerprintVerified"])
        finally:
            platform.stop()

    def test_platform_ack_rejection_stops_the_receipt(self):
        """NO-62a：平台在 ack 时复核失败（409）→ 不回执"已执行"，也不重试同一命令。"""
        platform = _StubPlatform([command(), command(commandId="att-2")], ack_status=409)
        try:
            adapter, _transport = make_adapter()
            agent = ControlAgent(ControlDownlinkClient(platform.url, "k"), {"AGV-01": adapter})

            stats = agent.run_once("AGV-01")

            self.assertEqual(len(stats["outcomes"]), 2)
            for outcome in stats["outcomes"]:
                self.assertEqual(outcome["outcome"], "delivery_rejected_by_platform")
                self.assertEqual(outcome["ackStatus"], 409)
            # 关键：没有回执（平台已经撤回命令，回执"执行成功"会把失效授权洗白）
            self.assertEqual(platform.receipts, [])
        finally:
            platform.stop()

    def test_safety_command_jumps_the_queue_and_reports_platform_order(self):
        """NO-62b：平台顺序退化时按优先级重排（stop 先执行）并显式上报顺序违规。"""
        platform = _StubPlatform([
            command(commandId="att-dispatch", commandKey="dispatch_task",
                    sentAt="2026-09-12T03:00:00.000Z"),
            command(commandId="att-stop", commandKey="stop", payload=None,
                    sentAt="2026-09-12T03:09:00.000Z"),
        ], pending_extra={"queued": 2, "revoked": 0, "checkedAt": "2026-09-12T03:10:00.000Z"})
        try:
            adapter, transport = make_adapter()
            agent = ControlAgent(ControlDownlinkClient(platform.url, "k"), {"AGV-01": adapter})

            stats = agent.run_once("AGV-01")

            executed = [o["commandId"] for o in stats["outcomes"]]
            self.assertEqual(executed, ["att-stop", "att-dispatch"])
            self.assertEqual(platform.acks[0]["commandId"], "att-stop")
            self.assertEqual(stats["queuedOnPlatform"], 2)
            self.assertEqual(stats["checkedAt"], "2026-09-12T03:10:00.000Z")
            self.assertEqual(
                stats["platformOrderViolation"],
                {"platform": ["att-dispatch", "att-stop"], "local": ["att-stop", "att-dispatch"]},
            )
            # 安全停机真的落到了设备上（先 idle 再被搬运命令改回 moving）
            self.assertEqual(transport.state.last_command_key, "dispatch_task")
        finally:
            platform.stop()

    def test_platform_order_matching_priority_reports_no_violation(self):
        """平台已按优先级排序时不得误报顺序违规（避免"狼来了"）。"""
        platform = _StubPlatform([
            command(commandId="att-stop", commandKey="stop", payload=None,
                    sentAt="2026-09-12T03:09:00.000Z"),
            command(commandId="att-dispatch", commandKey="dispatch_task",
                    sentAt="2026-09-12T03:00:00.000Z"),
        ])
        try:
            adapter, _transport = make_adapter()
            agent = ControlAgent(ControlDownlinkClient(platform.url, "k"), {"AGV-01": adapter})
            stats = agent.run_once("AGV-01")
            self.assertNotIn("platformOrderViolation", stats)
            self.assertEqual([o["commandId"] for o in stats["outcomes"]], ["att-stop", "att-dispatch"])
        finally:
            platform.stop()

    def test_cli_once_against_stub_platform(self):
        import subprocess

        platform = _StubPlatform([command()])
        try:
            # tests 在 src/edge_platform/tests/ → 仓库根要再上两级
            repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
            proc = subprocess.run(
                [
                    sys.executable,
                    os.path.join(repo_root, "tools", "edge_control_agent.py"),
                    "--once",
                    "--device", "AGV-01",
                    "--platform-url", platform.url,
                    "--ingest-key", "k",
                ],
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr[-500:])
            payload = json.loads(proc.stdout.strip().splitlines()[-1])
            self.assertEqual(payload["event"], "control_agent_round")
            self.assertEqual(payload["executed"], 1)
            self.assertEqual(platform.receipts[0]["result"], "executed")
        finally:
            platform.stop()


if __name__ == "__main__":
    unittest.main()


class SignedFingerprintBoundaryTest(unittest.TestCase):
    """NO-65a：签名指纹（hmac-sha256:v2）在**碰设备之前**验签。"""

    SECRET = "test-secret"

    def _signed_command(self, **overrides):
        payload = {"targetStationId": "ST-1", "taskId": "T-1"}
        scope = {
            "requestId": "ctl-1",
            "deviceId": "AGV-01",
            "commandKey": "dispatch_task",
            "approvalInstanceId": "AP-9",
        }
        fingerprint = authorization_fingerprint_v2(
            scope["requestId"], scope["deviceId"], scope["commandKey"],
            scope["approvalInstanceId"], payload, self.SECRET,
        )
        return command(
            authorizationFingerprint=fingerprint,
            authorizationScope=scope,
            payload=payload,
            **overrides,
        )

    def test_valid_signature_is_verified_and_executed(self):
        platform = _StubPlatform([self._signed_command()])
        try:
            adapter, transport = make_adapter()
            agent = ControlAgent(
                ControlDownlinkClient(platform.url, "k"),
                {"AGV-01": adapter},
                fingerprint_secret=self.SECRET,
            )
            stats = agent.run_once("AGV-01")
            self.assertEqual(stats["outcomes"][0]["outcome"], "executed")
            self.assertEqual(platform.acks[0]["details"]["fingerprintScheme"], "hmac-sha256:v2")
            self.assertTrue(platform.acks[0]["details"]["fingerprintVerified"])
            self.assertEqual(transport.state.state, "moving")
        finally:
            platform.stop()

    def test_tampered_payload_is_rejected_without_touching_device(self):
        """中转环节改了参数（例如把目标工位换掉）→ 验签失败 → 拒绝投递且设备不动。"""
        tampered = self._signed_command()
        tampered["payload"] = {"targetStationId": "ST-9", "taskId": "T-1"}
        platform = _StubPlatform([tampered])
        try:
            adapter, transport = make_adapter()
            agent = ControlAgent(
                ControlDownlinkClient(platform.url, "k"),
                {"AGV-01": adapter},
                fingerprint_secret=self.SECRET,
            )
            stats = agent.run_once("AGV-01")
            outcome = stats["outcomes"][0]
            self.assertEqual(outcome["outcome"], "delivery_rejected")
            self.assertEqual(outcome["reason"], "fingerprint_signature_invalid")
            self.assertEqual(platform.receipts, [])
            self.assertEqual(transport.state.state, "idle")  # 绝不碰设备
            self.assertIsNone(transport.state.last_authorization_ref)
        finally:
            platform.stop()

    def test_scope_device_mismatch_is_rejected(self):
        """签名覆盖的设备号必须就是本机（防跨设备重放）。"""
        c = self._signed_command()
        c["authorizationScope"] = {**c["authorizationScope"], "deviceId": "AGV-OTHER"}
        platform = _StubPlatform([c])
        try:
            adapter, transport = make_adapter()  # 本机 AGV-01
            agent = ControlAgent(
                ControlDownlinkClient(platform.url, "k"),
                {"AGV-01": adapter},
                fingerprint_secret=self.SECRET,
            )
            stats = agent.run_once("AGV-01")
            self.assertEqual(stats["outcomes"][0]["outcome"], "delivery_rejected")
            self.assertEqual(transport.state.state, "idle")
        finally:
            platform.stop()

    def test_missing_local_secret_is_reported_not_faked(self):
        """本机没有密钥：**不假装验过**，如实标注后仍投递（否则现场漏配即停摆）。"""
        platform = _StubPlatform([self._signed_command()])
        try:
            adapter, _transport = make_adapter()
            agent = ControlAgent(ControlDownlinkClient(platform.url, "k"), {"AGV-01": adapter})
            stats = agent.run_once("AGV-01")
            self.assertEqual(stats["outcomes"][0]["outcome"], "executed")
            details = platform.acks[0]["details"]
            self.assertEqual(details["fingerprintScheme"], "hmac-sha256:v2")
            self.assertFalse(details["fingerprintVerified"])
            self.assertEqual(details["fingerprintNote"], "fingerprint_secret_missing")
        finally:
            platform.stop()

    def test_wrong_key_is_rejected(self):
        platform = _StubPlatform([self._signed_command()])
        try:
            adapter, transport = make_adapter()
            agent = ControlAgent(
                ControlDownlinkClient(platform.url, "k"),
                {"AGV-01": adapter},
                fingerprint_secret="another-secret",
            )
            stats = agent.run_once("AGV-01")
            self.assertEqual(stats["outcomes"][0]["reason"], "fingerprint_signature_invalid")
            self.assertEqual(transport.state.state, "idle")
        finally:
            platform.stop()

    def test_approval_exempt_command_with_v2_fingerprint_is_delivered(self):
        """NO-68b：**免审批**命令带 v2 签名指纹时必须能投递（含安全停机 `stop`）。

        回归的是一处**安全相关**的错误：边缘原来把"没有审批实例号"当成
        "授权范围不可重建"，直接返回 `fingerprint_signature_missing_scope` 并拒绝投递。
        免审批命令本来就没有审批实例号（平台签发时按空串参与材料），于是一旦两侧配好
        `EWOH_CONTROL_FINGERPRINT_SECRET`（**推荐的生产姿态**），
        `pause`/`stop`/`return_to_dock` 全部投不出去——**安全动作反而不可达**，
        与"stop 永不受审批/排队/配额约束且投递优先级最高"的不变量直接冲突。
        """
        for command_key in ("pause", "stop", "return_to_dock"):
            for approval_scope in ("absent", "null"):
                with self.subTest(command_key=command_key, approval=approval_scope):
                    payload = {"note": "approval-exempt"}
                    scope = {
                        "requestId": "ctl-none",
                        "deviceId": "AGV-01",
                        "commandKey": command_key,
                    }
                    if approval_scope == "null":
                        scope["approvalInstanceId"] = None
                    # 平台侧签发：缺失审批实例按空串参与材料（与 TS 侧同口径）。
                    fingerprint = authorization_fingerprint_v2(
                        scope["requestId"], scope["deviceId"], scope["commandKey"],
                        scope.get("approvalInstanceId"), payload, self.SECRET,
                    )
                    platform = _StubPlatform([command()])  # 先让设备动起来
                    try:
                        adapter, transport = make_adapter()
                        agent = ControlAgent(
                            ControlDownlinkClient(platform.url, "k"),
                            {"AGV-01": adapter},
                            fingerprint_secret=self.SECRET,
                        )
                        agent.run_once("AGV-01")
                        self.assertEqual(transport.state.state, "moving")

                        platform.commands = [
                            command(
                                commandId="att-exempt",
                                commandKey=command_key,
                                authorizationRef="control:ctl-none",
                                requestId="ctl-none",
                                payload=payload,
                                authorizationFingerprint=fingerprint,
                                authorizationScope=scope,
                            )
                        ]
                        platform.acks.clear()
                        platform.receipts.clear()

                        stats = agent.run_once("AGV-01")
                        outcome = stats["outcomes"][0]
                        # 关键不变量：投递闸门**没有**把它拒掉（"设备不接受"是另一回事）。
                        self.assertNotEqual(
                            outcome["outcome"], "delivery_rejected",
                            f"{command_key}/{approval_scope} 被投递闸门拒绝：{outcome}",
                        )
                        self.assertEqual(outcome["outcome"], "executed", outcome)
                        details = platform.acks[0]["details"]
                        self.assertTrue(details["fingerprintVerified"])
                        self.assertEqual(details["fingerprintScheme"], "hmac-sha256:v2")
                        self.assertEqual(details["adapterAccepted"], True)
                        self.assertEqual(transport.state.last_command_key, command_key)
                    finally:
                        platform.stop()

    def test_payload_less_command_with_platform_null_payload_is_delivered(self):
        """平台 payload 缺失（null）的命令必须照常验签投递（含安全停机 `stop`）。

        平台真实形态（control.service.ts）：`POST /:id/commands` 不带 payload 时
        `validateCommandPayload` 返回 **null**，pending 响应即 `"payload": null`，
        签发材料按 `canonicalJson(null)` = `"null"` 参与（shared/actuator.ts）。
        回归缺陷：边缘曾把非 dict payload 归一成 `{}` → 材料算成 `"{}"`，与签发
        不一致 → 验签必败 → 配好密钥的生产姿态下**所有 payload 缺失的命令（含
        stop）都被 `fingerprint_signature_invalid` 拒掉**——NO-68b 修掉的
        "安全动作不可达"换了一条路复发。
        """
        for command_key in ("stop", "pause"):
            with self.subTest(command_key=command_key):
                scope = {
                    "requestId": "ctl-np",
                    "deviceId": "AGV-01",
                    "commandKey": command_key,
                    "approvalInstanceId": None,
                }
                # 平台侧签发：payload 缺失按 None（材料里是 "null"）参与——与 TS 同口径。
                fingerprint = authorization_fingerprint_v2(
                    scope["requestId"], scope["deviceId"], scope["commandKey"],
                    scope["approvalInstanceId"], None, self.SECRET,
                )
                platform = _StubPlatform([command()])  # 先让设备动起来
                try:
                    adapter, transport = make_adapter()
                    agent = ControlAgent(
                        ControlDownlinkClient(platform.url, "k"),
                        {"AGV-01": adapter},
                        fingerprint_secret=self.SECRET,
                    )
                    agent.run_once("AGV-01")
                    self.assertEqual(transport.state.state, "moving")

                    platform.commands = [
                        command(
                            commandId="att-np",
                            commandKey=command_key,
                            authorizationRef="control:ctl-np",
                            requestId="ctl-np",
                            payload=None,  # 平台 pending 响应里 payload 缺失就是 null
                            authorizationFingerprint=fingerprint,
                            authorizationScope=scope,
                        )
                    ]
                    platform.acks.clear()
                    platform.receipts.clear()

                    stats = agent.run_once("AGV-01")
                    outcome = stats["outcomes"][0]
                    self.assertNotEqual(
                        outcome["outcome"], "delivery_rejected",
                        f"{command_key} 被投递闸门拒绝：{outcome}",
                    )
                    self.assertEqual(outcome["outcome"], "executed", outcome)
                    self.assertTrue(platform.acks[0]["details"]["fingerprintVerified"])
                    self.assertEqual(platform.receipts[0]["result"], "executed")
                finally:
                    platform.stop()

    def test_tampered_null_payload_is_still_rejected(self):
        """修复不得把验签放宽成摆设：签发时 payload 为对象、传输被剥成 null → 必须拒。"""
        signed = self._signed_command()  # 签名覆盖 {"targetStationId": ...}
        signed["payload"] = None  # 中转环节把参数剥掉
        platform = _StubPlatform([signed])
        try:
            adapter, transport = make_adapter()
            agent = ControlAgent(
                ControlDownlinkClient(platform.url, "k"),
                {"AGV-01": adapter},
                fingerprint_secret=self.SECRET,
            )
            stats = agent.run_once("AGV-01")
            outcome = stats["outcomes"][0]
            self.assertEqual(outcome["outcome"], "delivery_rejected")
            self.assertEqual(outcome["reason"], "fingerprint_signature_invalid")
            self.assertEqual(transport.state.state, "idle")
        finally:
            platform.stop()

    def test_signed_fingerprint_without_scope_is_rejected(self):
        """签名指纹却**没给 `authorizationScope`**：范围确实不可重建 → 拒绝投递（不猜）。

        这才是 `fingerprint_signature_missing_scope` 真正该拦的情形。
        """
        c = self._signed_command()
        c.pop("authorizationScope", None)
        platform = _StubPlatform([c])
        try:
            adapter, transport = make_adapter()
            agent = ControlAgent(
                ControlDownlinkClient(platform.url, "k"),
                {"AGV-01": adapter},
                fingerprint_secret=self.SECRET,
            )
            stats = agent.run_once("AGV-01")
            outcome = stats["outcomes"][0]
            self.assertEqual(outcome["outcome"], "delivery_rejected")
            self.assertEqual(outcome["reason"], "fingerprint_signature_missing_scope")
            self.assertEqual(platform.receipts, [])
            self.assertEqual(transport.state.state, "idle")  # 绝不碰设备
        finally:
            platform.stop()

    def test_signed_fingerprint_with_empty_scope_dict_is_rejected(self):
        """`authorizationScope` 是**空对象**时与"没下发"同罪：同样按 missing_scope 拒。

        钉死 `scope_present=bool(scope)` 的语义边界：边缘判"范围可否重建"看的是
        平台**有没有下发非空 authorizationScope**，空对象与字段缺失是一回事。
        （当前平台端 listPendingCommands 恒回填全部四字段，空 dict 只可能来自
        异常中转/半实现的仿冒端——fail-closed，不猜。）
        """
        c = self._signed_command()
        c["authorizationScope"] = {}
        platform = _StubPlatform([c])
        try:
            adapter, transport = make_adapter()
            agent = ControlAgent(
                ControlDownlinkClient(platform.url, "k"),
                {"AGV-01": adapter},
                fingerprint_secret=self.SECRET,
            )
            stats = agent.run_once("AGV-01")
            outcome = stats["outcomes"][0]
            self.assertEqual(outcome["outcome"], "delivery_rejected")
            self.assertEqual(outcome["reason"], "fingerprint_signature_missing_scope")
            self.assertEqual(platform.receipts, [])
            self.assertEqual(transport.state.state, "idle")  # 绝不碰设备
        finally:
            platform.stop()

    def test_safety_stop_with_signed_fingerprint_is_never_blocked(self):
        """安全停机在"配好密钥"的生产姿态下必须仍可投递（不变量：安全动作不被授权链卡住）。"""
        payload = {"reason": "e2e-safety"}
        scope = {
            "requestId": "ctl-stop",
            "deviceId": "AGV-01",
            "commandKey": "stop",
            # 平台 `stop` 免审批 → 无审批实例号
        }
        fingerprint = authorization_fingerprint_v2(
            scope["requestId"], scope["deviceId"], scope["commandKey"], None, payload, self.SECRET,
        )
        platform = _StubPlatform([command()])  # 先让设备跑起来
        try:
            adapter, transport = make_adapter()
            agent = ControlAgent(
                ControlDownlinkClient(platform.url, "k"),
                {"AGV-01": adapter},
                fingerprint_secret=self.SECRET,
            )
            agent.run_once("AGV-01")
            self.assertEqual(transport.state.state, "moving")

            platform.commands = [
                command(
                    commandId="att-stop",
                    commandKey="stop",
                    authorizationRef="control:ctl-stop",
                    requestId="ctl-stop",
                    payload=payload,
                    authorizationFingerprint=fingerprint,
                    authorizationScope=scope,
                )
            ]
            stats = agent.run_once("AGV-01")
            self.assertEqual(stats["outcomes"][0]["outcome"], "executed")
            # `stop` 是安全停机（安全落点 idle；`pause` 才是 paused）——真的到了设备。
            self.assertEqual(transport.state.state, "idle")
            self.assertEqual(transport.state.last_command_key, "stop")
            self.assertTrue(platform.acks[0]["details"]["fingerprintVerified"])
        finally:
            platform.stop()


class CrossLanguageFingerprintVectorTest(unittest.TestCase):
    """NO-65a：v2 指纹的**跨语言固定向量**（TS 侧同一断言在 shared/actuator.spec.ts）。"""

    def test_v2_vector_matches_platform_implementation(self):
        fingerprint = authorization_fingerprint_v2(
            "CR-1", "AGV-01", "dispatch_task", "AP-9",
            {"targetStationId": "ST-2"}, "test-secret",
        )
        self.assertEqual(fingerprint, "hmac-sha256:v2:906de7f6e09dbd1adb6b5ae99d038876")
        # 篡改任一维度都不再匹配
        self.assertNotEqual(
            authorization_fingerprint_v2(
                "CR-1", "AGV-01", "dispatch_task", "AP-9",
                {"targetStationId": "ST-3"}, "test-secret",
            ),
            fingerprint,
        )
        # 空密钥必须报错（不得"用空密钥签名"）
        with self.assertRaises(ValueError):
            authorization_fingerprint_v2("CR-1", "AGV-01", "stop", None, None, "")

    def test_v2_null_payload_vector_matches_platform_implementation(self):
        """payload 缺失（null）的跨语言固定向量。

        平台对"没带参数的命令"签发材料按 `canonicalJson(null)` = `"null"` 参与
        （shared/actuator.ts；控制面 `validateCommandPayload` 对无参数命令返回 null）。
        边缘必须同样把缺失当 **None**（不是 `{}`）传进材料——归一成 `{}` 会把材料
        算成 `"{}"`，与平台签发不一致，payload 缺失的命令验签全部失败。
        TS 侧同断言：authorizationFingerprintV2({...payload:null}, 'test-secret', hmac)。
        """
        self.assertEqual(
            authorization_fingerprint_v2("CR-1", "AGV-01", "stop", None, None, "test-secret"),
            "hmac-sha256:v2:0d00c11d98b965b4dabb502b77068a0c",
        )


if __name__ == "__main__":
    unittest.main()
