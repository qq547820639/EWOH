"""EDGE-02 重裁决（V94）：命令下行的**重复动作**与**结果存活**四条边界（假平台 + 假执行机构）。

登记原文写的是"边缘无命令去重键 ⇒ 平台重复投递同一 commandId 会二次 send_command（二次动设备）"。
本轮把它推到实测，结论是**该危害不成立**，而真正的洞在别处：

  · `ControlAgent._handle` 的安全顺序是 **先 ack 成功、后动设备**（control_downlink.py:467-518）：
    ack 非 2xx 直接返回、**不碰设备**；
  · 平台侧 `ackCommand` 的 CAS 起始集只有 `['sent']`（control.service.ts:2888），未命中即 409
    ⇒ 两个网关进程并发也不会都拿到"确认成功"；
  · `listPendingCommands` 只返回 `status='sent'` 的行（链上常驻实测：V67 D-01/D-03、V72 D-04/D-05）
    ⇒ 一旦 ack 成功，该命令不再出现在待投面。

所以"二次动设备"需要一条"已动过设备的命令被重新列出"的路径，上面三条把它堵死了。
留下来的是两个**结果/活性**问题，本文件把它们钉住（含翻案条件）：

  E2-A1 不变量（安全）：ack 结果未知时不得动设备；恢复后恰好动一次。
  E2-A2 现状钉住（缺陷）：未配置 `--receipt-journal`（**默认**）时，回执失败后重启
        ⇒ 执行结果永久丢失（命令已离开 sent，不会重投）。
        翻案条件：CLI 默认给出持久 journal 路径（属部署约定，需运维拍板落点）之后，
        本例应改为"重启后补投成功"，与 E2-A3 同形。
  E2-A3 不变量（已修能力）：配置 journal 后重启补投成功 ⇒ 不重复动作、结果不丢、journal 清空。
  E2-A4 现状钉住（活性）：崩溃发生在"ack 成功之后、动设备之前"⇒ 设备从未动，
        命令也不会重投；平台侧由 F-02 过期收敛把它判为 `expired`
        （`IN_FLIGHT_ATTEMPT_STATUSES` 含 `gateway_received`，control.service.ts:354），
        现场表现为"命令静默不生效 + 一条积压提醒"。
        翻案条件：若引入"网关侧执行意图持久化 + 重启后按意图续做"，本例应看到动作发生一次。
  E2-A5 现状钉住（缺陷）：journal 未配置时溢出（`receipt_retry_max`）路径**直接抛 RuntimeError**
        ——死信落盘需要路径，内存态无处可落。
        翻案条件：要么溢出时降级为"计数 + 告警 + 丢弃"（与 `receipt_retry_dropped` 语义一致），
        要么默认落点存在（见 E2-A2）。
"""
import os
import tempfile
import unittest

from edge_platform.edge.bridge.control_downlink import (
    ControlAgent,
    ControlDownlinkClient,
    ReceiptJournal,
)
from edge_platform.tests.test_control_downlink import _StubPlatform, command, make_adapter


def counted_adapter():
    """返回 (适配器, 传输, 动作台账)。动作台账就是"设备被动了几次"的唯一权威计数。"""
    adapter, transport = make_adapter()
    calls = []
    original = adapter.send_command

    def wrapping(*args, **kwargs):
        calls.append(str(args[0] if args else kwargs.get("command_key")))
        return original(*args, **kwargs)

    adapter.send_command = wrapping
    adapter.restore_send = lambda: setattr(adapter, "send_command", original)
    return adapter, transport, calls


class _PlatformWithStateMachine:
    """把已实测的平台语义建进桩：ack 成功 ⇒ 命令离开待投面。

    为什么必须这样建模：仓库自带的 `_StubPlatform` 无条件返回预置命令，等于替平台构造了
    一个真实状态机不允许的状态——第一版探针因此量出"设备被动两次"，那是仪器造的假象。
    """

    def __init__(self, commands):
        self.platform = _StubPlatform(list(commands))
        self.client = ControlDownlinkClient(self.platform.url, "k")
        self.raw_ack, self.raw_receipt = self.client.ack, self.client.receipt
        self.client.ack = self._ack
        self.client.receipt = self._receipt
        self.ack_fault = None
        self.receipt_fault = None

    def _ack(self, command_id, *args, **kwargs):
        if self.ack_fault is not None:
            return self.ack_fault, {"error": "simulated_ack_fault"}
        status, body = self.raw_ack(command_id, *args, **kwargs)
        if status in (200, 201):
            self.platform.commands = [
                c for c in self.platform.commands if c.get("commandId") != command_id
            ]
        return status, body

    def _receipt(self, command_id, *args, **kwargs):
        if self.receipt_fault is not None:
            return self.receipt_fault, {"error": "simulated_receipt_fault"}
        return self.raw_receipt(command_id, *args, **kwargs)

    @property
    def listed(self):
        return [c.get("commandId") for c in self.platform.commands]

    def stop(self):
        self.platform.stop()


class Edge02RedeterminationTest(unittest.TestCase):
    def _journal_file(self):
        handle = tempfile.NamedTemporaryFile(prefix="edge02-journal-", suffix=".jsonl", delete=False)
        handle.close()
        self.addCleanup(lambda: os.path.exists(handle.name) and os.unlink(handle.name))
        self.addCleanup(
            lambda: os.path.exists(f"{handle.name}.dead-letter.jsonl")
            and os.unlink(f"{handle.name}.dead-letter.jsonl")
        )
        return handle.name

    def test_a1_ack结果未知时不动设备_恢复后恰好动一次(self):
        world = _PlatformWithStateMachine([command()])
        try:
            adapter, transport, calls = counted_adapter()
            agent = ControlAgent(world.client, {"AGV-01": adapter})
            world.ack_fault = 500
            first = agent.run_once("AGV-01")
            self.assertEqual(first["outcomes"][0]["outcome"], "authorization_ack_unresolved")
            self.assertEqual(calls, [], "ack 未成功 ⇒ 不碰设备（安全顺序）")
            self.assertEqual(transport.state.state, "idle")

            world.ack_fault = None
            second = agent.run_once("AGV-01")
            self.assertEqual(second["outcomes"][0]["outcome"], "executed")
            self.assertEqual(calls, ["dispatch_task"], "命令留在待投面 ⇒ 恢复后恰好动一次，不是两次")
        finally:
            world.stop()

    def test_a2_默认无journal_重启后执行结果永久丢失_现状钉住(self):
        world = _PlatformWithStateMachine([command()])
        try:
            adapter, _transport, calls = counted_adapter()
            agent = ControlAgent(world.client, {"AGV-01": adapter})   # 默认形状：不配 journal
            world.receipt_fault = 503
            first = agent.run_once("AGV-01")
            self.assertEqual(first["outcomes"][0]["outcome"], "executed")
            self.assertEqual(len(agent._receipt_retry.entries), 1, "执行结果先进内存待重投队列")
            self.assertEqual(agent._receipt_retry.path, "", "默认没有持久化落点")

            world.receipt_fault = None
            restarted = ControlAgent(world.client, {"AGV-01": adapter})
            second = restarted.run_once("AGV-01")

            self.assertEqual(second["polled"], 0, "ack 已让命令离开 sent ⇒ 不会二次动设备")
            self.assertEqual(calls, ["dispatch_task"])
            self.assertEqual(restarted._receipt_retry.entries, [], "内存队列 ⇒ 重启即丢")
            self.assertEqual(world.platform.receipts, [], "平台从未收到这条执行结果")
        finally:
            world.stop()

    def test_a2b_不持久记账必须在发生时告警(self):
        journal = ReceiptJournal(None)
        warnings = []
        original = journal  # 用 logger 捕获替代：直接断言标志位与文案来源
        with self.assertLogs("edge_platform.edge.bridge.control_downlink", level="WARNING") as captured:
            journal.append({"commandId": "att-x", "commandKey": "dispatch_task", "result": "executed",
                            "receiptBody": {}, "fingerprint": None})
        joined = "\n".join(captured.output)
        self.assertIn("只记在内存中", joined)
        self.assertIn("--receipt-journal", joined)
        self.assertTrue(journal.warned_not_durable, "只告警一次，避免每轮刷屏")
        del original, warnings

    def test_a3_配置journal_重启补投成功_不重复也不丢失(self):
        path = self._journal_file()
        world = _PlatformWithStateMachine([command()])
        try:
            adapter, _transport, calls = counted_adapter()
            world.receipt_fault = 503
            ControlAgent(world.client, {"AGV-01": adapter}, receipt_journal_path=path).run_once("AGV-01")
            self.assertNotEqual(os.path.getsize(path), 0, "瞬时失败必须落盘")

            world.receipt_fault = None
            restarted = ControlAgent(world.client, {"AGV-01": adapter}, receipt_journal_path=path)
            second = restarted.run_once("AGV-01")
            self.assertEqual(second["receiptRetryFlushed"], 1)
            self.assertEqual(second["polled"], 0, "run_once 先补投再拉取 ⇒ 不会重复动设备")
            self.assertEqual(calls, ["dispatch_task"])
            self.assertEqual([r["commandId"] for r in world.platform.receipts], ["att-1"])
            self.assertEqual(os.path.getsize(path), 0, "补投成功后清空")
        finally:
            world.stop()

    def test_a4_ack后动设备前崩溃_命令静默不生效_现状钉住(self):
        world = _PlatformWithStateMachine([command()])
        try:
            adapter, _transport, calls = counted_adapter()
            agent = ControlAgent(world.client, {"AGV-01": adapter})

            def crash_after_ack_before_actuation(*args, **kwargs):
                raise KeyboardInterrupt("进程在 ack 之后、动设备之前消失")

            adapter.send_command = crash_after_ack_before_actuation
            with self.assertRaises(KeyboardInterrupt):
                agent.run_once("AGV-01")
            adapter.restore_send()

            self.assertEqual(world.listed, [], "ack 已把命令带出待投面 ⇒ 没有任何一侧会再来取它")
            restarted = ControlAgent(world.client, {"AGV-01": adapter})
            second = restarted.run_once("AGV-01")
            self.assertEqual(second["polled"], 0)
            self.assertEqual(calls, [], "设备从未动，也没有补投 ⇒ 该命令在边缘侧永久不生效")
            self.assertEqual(restarted._receipt_retry.entries, [])
        finally:
            world.stop()

    def test_a5_未配置journal时溢出直接抛错_现状钉住(self):
        journal = ReceiptJournal(None)
        with self.assertRaises(RuntimeError):
            journal.overflow({"commandId": "att-y"})


if __name__ == "__main__":
    unittest.main()
