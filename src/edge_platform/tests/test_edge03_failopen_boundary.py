"""EDGE-03 边界（V95）：本机**没有**指纹密钥时，边缘到底放弃了哪一道防线（假平台 + 假执行机构）。

登记原文只写"P1：缺密钥时 `fingerprint_secret_missing` 不阻断执行"。本轮把它推到实测，
量的是**代价**而不是"是否阻断"：
  · 密钥配好时，中转环节篡改 payload / 把签名 scope 里的设备号改成别的设备，都会在**碰设备之前**被拒
    （`test_control_downlink.py::SignedFingerprintBoundaryTest` 已常驻）；
  · 密钥缺失时，这两条还剩几条？

三条都可翻：与预期不符就据实改结论，不许把推断写成已证实。
现状钉住的两例（E3-A/E3-C）写明**翻案条件**——一旦裁决改为 fail-closed
（或只对高危 commandKey fail-closed），它们应当变红，届时按新裁决重写而不是删掉。
"""
import unittest

from edge_platform.edge.bridge.control_downlink import (
    ControlAgent,
    ControlDownlinkClient,
)
from edge_platform.edge.adapters.actuator.protocol import authorization_fingerprint_v2
from edge_platform.tests.test_control_downlink import _StubPlatform, command, make_adapter

SECRET = "edge03-test-secret"


def signed(**overrides):
    payload = {"targetStationId": "ST-1", "taskId": "T-1"}
    scope = {
        "requestId": "ctl-1",
        "deviceId": "AGV-01",
        "commandKey": "dispatch_task",
        "approvalInstanceId": "AP-9",
    }
    fingerprint = authorization_fingerprint_v2(
        scope["requestId"], scope["deviceId"], scope["commandKey"],
        scope["approvalInstanceId"], payload, SECRET,
    )
    return command(authorizationFingerprint=fingerprint, authorizationScope=scope,
                   payload=payload, **overrides)


class Edge03FailOpenBoundaryTest(unittest.TestCase):
    def agent(self, platform, *, with_secret: bool):
        adapter, transport = make_adapter()
        agent = ControlAgent(
            ControlDownlinkClient(platform.url, "k"),
            {"AGV-01": adapter},
            fingerprint_secret=SECRET if with_secret else None,
        )
        return agent, adapter, transport

    def test_e3a_密钥缺失时篡改过的payload仍会落到设备_现状钉住(self):
        """翻案条件：若裁决改为"带 v2 指纹但本机无法验签 ⇒ 拒绝投递"，本例应变 red（设备不动）。"""
        tampered = signed()
        tampered["payload"] = {"targetStationId": "ST-9", "taskId": "T-1"}   # 中转环节改了目标工位
        platform = _StubPlatform([tampered])
        try:
            _agent, _adapter, transport = self.agent(platform, with_secret=False)
            stats = _agent.run_once("AGV-01")
            outcome = stats["outcomes"][0]

            self.assertEqual(outcome["outcome"], "executed")
            self.assertEqual(transport.state.state, "moving")
            self.assertEqual(transport.state.target_station_id, "ST-9", "被篡改的目标工位真的执行了")
            details = platform.acks[0]["details"]
            self.assertEqual(details["fingerprintScheme"], "hmac-sha256:v2")
            self.assertFalse(details["fingerprintVerified"])
            self.assertEqual(details["fingerprintNote"], "fingerprint_secret_missing")
        finally:
            platform.stop()

    def test_e3b_同一篡改在密钥配置时被碰设备之前挡下_对照(self):
        """与 E3-A 只差一个变量：本机是否持有密钥。没有这条对照，E3-A 的结论无从校准。"""
        tampered = signed()
        tampered["payload"] = {"targetStationId": "ST-9", "taskId": "T-1"}
        platform = _StubPlatform([tampered])
        try:
            agent, _adapter, transport = self.agent(platform, with_secret=True)
            stats = agent.run_once("AGV-01")
            outcome = stats["outcomes"][0]
            self.assertEqual(outcome["outcome"], "delivery_rejected")
            self.assertEqual(outcome["reason"], "fingerprint_signature_invalid")
            self.assertEqual(transport.state.state, "idle")
            self.assertIsNone(transport.state.target_station_id)
            self.assertEqual(platform.receipts, [])
        finally:
            platform.stop()

    def test_e3c_密钥缺失时跨设备重放的scope也不设防_现状钉住(self):
        """签名里写的是别的设备（AGV-OTHER）。有密钥 ⇒ 拒；无密钥 ⇒ 现在会怎样？

        翻案条件：同 E3-A（fail-closed 裁决落地后本例应红）。
        """
        replayed = signed()
        replayed["authorizationScope"] = {**replayed["authorizationScope"], "deviceId": "AGV-OTHER"}
        platform = _StubPlatform([replayed])
        try:
            agent, _adapter, transport = self.agent(platform, with_secret=False)
            stats = agent.run_once("AGV-01")
            outcome = stats["outcomes"][0]
            self.assertEqual(outcome["outcome"], "executed")
            self.assertEqual(transport.state.state, "moving")

            # 同一份报文在有密钥时必须被挡（防止把 E3-C 读成"签名根本不覆盖设备号"）
            platform2 = _StubPlatform([dict(replayed)])
            try:
                agent2, _a2, transport2 = self.agent(platform2, with_secret=True)
                stats2 = agent2.run_once("AGV-01")
                self.assertEqual(stats2["outcomes"][0]["outcome"], "delivery_rejected")
                self.assertEqual(transport2.state.state, "idle")
            finally:
                platform2.stop()
        finally:
            platform.stop()


if __name__ == "__main__":
    unittest.main()
