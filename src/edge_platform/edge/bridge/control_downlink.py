"""平台命令下行：轮询 + 投递确认 + 执行回执（NO-60a）。

闭环位置：

```
平台（人审/审批 → 授权 → sendCommand 落库）
        ↓  GET  /api/control/commands/pending?deviceId=…   （本模块轮询）
边缘命令代理 ControlAgent
        ↓  ActuatorAdapter.send_command(commandKey, authorizationRef, payload)
执行机构（回环模拟 / Modbus / OPC-UA / 厂商 API）
        ↑  POST /api/control/commands/:id/ack              （投递确认：gateway_received / failed）
        ↑  POST /api/control/requests/:id/receipts         （执行结果：executed / failed）
```

为什么是轮询：工厂边缘常在内网/NAT 后，平台无法直连；轮询 + 幂等 ack 是能在现场落地
的下行方式，不引入新基础设施（MQTT/反向隧道都可后补，接口不变）。

五条诚实边界（原则 4/6/7/8）：
1. **授权号只能由平台签发**：边缘只接受 `control:<requestId>` 且必须与命令自带的
   `requestId` 一致；不一致 → 投递拒绝（`authorization_ref_mismatch`），**不碰设备**；
2. **投递确认与执行结果是两件事**：网关收到但执行失败 → 先 ack `delivered=true`，
   再回执 `failed` + 原因（状态机 `gateway_received → failed`），不混为一谈；
3. **绝不静默**：每一条命令都会产生 ack（成功或带原因拒绝）与回执；
   网络失败时命令保持 `sent`，下一轮重新投递（幂等由平台 ack 保证）。
4. **授权范围指纹回传**（NO-62a）：平台在待投递命令里带上
   `authorizationFingerprint`（请求/设备/命令/审批实例/参数的规范指纹），
   边缘把它**原样回传**在 ack 与回执里。网关不自己"重算一个看起来对的"指纹——
   回传原值才能让平台发现"被执行的东西与被授权的东西不是一回事"；
5. **安全动作插队**（NO-62b）：投递顺序按命令优先级（`stop` 最先）。
   平台已按优先级排序，边缘侧再排一次并核对——顺序不一致时上报
   `platform_order_violation`（纵深防御，不静默接受一个"急停排在搬运后面"的顺序）。
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any

from edge_platform.edge.adapters.actuator.protocol import (
    command_priority,
    verify_authorization_fingerprint,
)

logger = logging.getLogger(__name__)

#: 投递失败原因（封闭词表）：与平台 ack 的 errorCode 语义对应。
DELIVERY_REASONS = (
    "authorization_ref_mismatch",
    "authorization_ref_missing",
    "unknown_device",
    "platform_unreachable",
    "invalid_command_payload",
    # NO-65a：授权范围签名验证失败（内容/范围被改写，或密钥不一致）→ 不碰设备。
    "fingerprint_signature_invalid",
    # NO-65a：平台发了签名指纹但没给可重建的授权范围 → 无法验证 → 不碰设备。
    "fingerprint_signature_missing_scope",
    # NO-65a：本机没有密钥验不了签名——**不拒绝**（否则漏配即停摆），但如实留痕。
    "fingerprint_secret_missing",
    "fingerprint_mismatch",
)


class ControlDownlinkClient:
    """平台控制命令面客户端（纯标准库；失败显式返回错误而不是抛穿调用栈）。"""

    def __init__(
        self,
        platform_url: str,
        ingest_key: str,
        *,
        org_id: str | None = None,
        timeout: float = 10.0,
    ):
        self.platform_url = str(platform_url).rstrip("/")
        self.ingest_key = ingest_key
        self.org_id = org_id
        self.timeout = timeout

    # ---- 内部 ----
    def _headers(self) -> dict:
        headers = {"X-Ingest-Key": self.ingest_key, "Content-Type": "application/json"}
        if self.org_id:
            headers["X-Org-Id"] = self.org_id
        return headers

    def _request(self, method: str, path: str, body: dict | None = None) -> tuple[int, Any]:
        url = f"{self.platform_url}{path}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, headers=self._headers(), method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:  # nosec B310 - 平台地址由部署方配置
                raw = resp.read().decode("utf-8", "replace")
                return resp.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", "replace")
            try:
                payload = json.loads(raw) if raw else None
            except json.JSONDecodeError:
                payload = {"raw": raw[:500]}
            return exc.code, payload
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            # 平台不可达：显式表达（调用方保持命令 pending，下一轮重投）
            return 0, {"error": "platform_unreachable", "detail": f"{type(exc).__name__}: {exc}"}

    # ---- 平台命令面 ----
    def pending(self, device_id: str, limit: int = 20) -> tuple[int, Any]:
        return self._request(
            "GET",
            f"/api/control/commands/pending?deviceId={urllib.parse.quote(str(device_id))}&limit={int(limit)}",
        )

    def ack(
        self,
        command_id: str,
        delivered: bool,
        *,
        reason: str | None = None,
        details: dict | None = None,
        authorization_fingerprint: str | None = None,
    ) -> tuple[int, Any]:
        body: dict[str, Any] = {"delivered": bool(delivered)}
        if reason:
            body["reason"] = reason
        merged: dict[str, Any] = dict(details or {})
        if authorization_fingerprint:
            # 原样回传（不重算）：平台据此比对"被执行的命令"与"被授权的范围"。
            merged["authorizationFingerprint"] = str(authorization_fingerprint)
        if merged:
            body["details"] = merged
        return self._request("POST", f"/api/control/commands/{urllib.parse.quote(str(command_id))}/ack", body)

    def receipt(
        self,
        command_id: str,
        command_key: str,
        result: str,
        receipt: dict | None = None,
        authorization_fingerprint: str | None = None,
    ) -> tuple[int, Any]:
        """回执执行结果**走网关命令面**（机器身份密钥），不是人面 `/requests/:id/receipts`。

        为什么：人面回执要 Bearer 用户令牌，边缘网关没有（也不该持有）人类凭据；
        用服务端密钥回执才是机器对机器的正确姿势（NO-60a 实测踩到：只发 key 会 401，
        命令停在 gateway_received、执行结果丢失）。
        """
        payload = dict(receipt or {})
        if authorization_fingerprint:
            payload["authorizationFingerprint"] = str(authorization_fingerprint)
        return self._request(
            "POST",
            f"/api/control/commands/{urllib.parse.quote(str(command_id))}/receipt",
            {"commandKey": command_key, "result": result, "receipt": payload},
        )


class ReceiptJournal:
    """原子持久化的失败回执账本：进程重启后仍能按原 commandId 补投。"""

    def __init__(self, path: str | None):
        self.path = str(path) if path else ""
        self.warned_not_durable = False
        self.entries: list[dict] = self._load()

    @staticmethod
    def _entry_key(entry: dict) -> str:
        """同一次执行事实的唯一键；重复追加在崩溃恢复时只保留一条。"""
        material = {
            "commandId": entry.get("commandId"),
            "commandKey": entry.get("commandKey"),
            "result": entry.get("result"),
            "receiptBody": entry.get("receiptBody"),
            "fingerprint": entry.get("fingerprint"),
        }
        return json.dumps(material, ensure_ascii=False, sort_keys=True, separators=(",", ":"))

    def _load(self) -> list[dict]:
        if not self.path or not os.path.exists(self.path):
            return []
        entries_by_key: dict[str, dict] = {}
        with open(self.path, encoding="utf-8") as stream:
            for line_number, line in enumerate(stream, 1):
                if not line.strip():
                    continue
                value = json.loads(line)
                if not isinstance(value, dict):
                    raise ValueError(f"invalid receipt journal entry at {self.path}:{line_number}")
                entries_by_key[self._entry_key(value)] = value
        return list(entries_by_key.values())

    def _rewrite(self, entries: list[dict]) -> None:
        if not self.path:
            return
        temporary = f"{self.path}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
        with open(temporary, "w", encoding="utf-8") as stream:
            for entry in entries:
                stream.write(json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, self.path)
        directory_fd = os.open(os.path.dirname(self.path) or ".", os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)

    def append(self, entry: dict) -> None:
        # 先把新事实 O_APPEND+fsync 到旧文件：即使压缩 rewrite 前崩溃，恢复也能读到它。
        # 崩溃后可能出现一条重复，_load 按 commandId/result/body 键去重。
        if self.path:
            with open(self.path, "a", encoding="utf-8") as stream:
                stream.write(json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n")
                stream.flush()
                os.fsync(stream.fileno())
            self.entries = self._load()
            return
        # EDGE-02b（V94 实测 A2）：未配置 journal 路径时，这条执行事实只活在内存里——
        # 进程一退就没了，而命令早已离开 `sent` 面（ack 先于动设备），平台永远收不到结果。
        # 不改变行为（仍留在内存），只把"这次记账不持久"在**发生的那一刻**说清楚：
        # 与仓库既有的"配置错误必须可见"同一纪律（NO-68a 间隔解析、NEST-504 回落告警）。
        if not self.warned_not_durable:
            self.warned_not_durable = True
            logger.warning(
                "失败回执只记在内存中（未配置 receipt journal 路径）：进程重启即永久丢失这条执行事实，"
                "且该命令不会再次投递（ack 先于动设备）。配置 --receipt-journal / "
                "EWOH_CONTROL_RECEIPT_JOURNAL 后重启可补投。"
            )
        self.entries.append(entry)
        self._rewrite(self.entries)

    def replace(self, entries: list[dict]) -> None:
        self.entries = list(entries)
        self._rewrite(self.entries)

    def overflow(self, entry: dict) -> None:
        """把超过内存上限的回执转入持久死信，而不是静默丢弃。"""
        if not self.path:
            raise RuntimeError("receipt journal path is required once the retry queue overflows")
        dead_letter = f"{self.path}.dead-letter.jsonl"
        with open(dead_letter, "a", encoding="utf-8") as stream:
            stream.write(json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n")
            stream.flush()
            os.fsync(stream.fileno())


class ControlAgent:
    """把平台待投递命令交给执行机构适配器，并把结果回执平台（一次一轮）。"""

    def __init__(
        self,
        client: ControlDownlinkClient,
        adapters: dict[str, Any],
        *,
        command_keys: tuple[str, ...] | None = None,
        fingerprint_secret: str | None = None,
        receipt_journal_path: str | None = None,
    ):
        self.client = client
        # device_id → ActuatorAdapter（必须是执行机构适配器；本类不做类型猜测）
        self.adapters = {str(k): v for k, v in adapters.items()}
        self.command_keys = command_keys
        #: NO-65a：授权范围指纹的 HMAC 密钥（部署配置）。缺省为空 = 只能做一致性核对，
        #: 会在 ack 详情里如实标注 `fingerprint_secret_missing`（不假装验过）。
        self.fingerprint_secret = str(fingerprint_secret or "").strip()
        #: FR8（2026-09-13）：receipt 上行失败的重投队列。listPendingCommands 只返回
        #: status='sent' 的命令——receipt 一旦丢失（平台瞬时不可达），停在
        #: gateway_received 的命令下一轮不会再出现，执行结果就**永久丢失**，
        #: 闭环声称的"绝不静默"在该路径不成立。这里按 (commandId, commandKey,
        #: receipt_body, fingerprint) 记账，每轮 run_once 先重投；平台按
        #: commandId 幂等接收（重复回执无副作用）。有界：条数上限 = self.receipt_retry_max
        #: （那是唯一生效的界，注释里不复述字面量，以免数字与实现各自漂移）；溢出
        #: **不是丢最旧**，而是由 ReceiptJournal.overflow() 转入持久死信
        #: <journal>.dead-letter.jsonl，并累加 receipt_retry_dropped 留痕。
        self._receipt_retry = ReceiptJournal(receipt_journal_path)
        self.receipt_retry_dropped = 0
        self.receipt_retry_rejected = 0
        self.receipt_retry_max = 1000

    def _reject(self, command: dict, reason: str, detail: str = "") -> dict:
        """投递拒绝：先 ack（delivered=false + 原因），**不碰设备**。"""
        status, body = self.client.ack(
            command.get("commandId", ""),
            False,
            reason=reason,
            details={"detail": detail} if detail else None,
        )
        return {
            "commandId": command.get("commandId"),
            "outcome": "delivery_rejected",
            "reason": reason,
            "ackStatus": status,
            "ackBody": body,
        }

    def run_once(self, device_id: str, limit: int = 20) -> dict:
        """处理一台设备的一轮：返回结构化统计（调用方/日志/测试都读它）。"""
        device = str(device_id)
        adapter = self.adapters.get(device)
        if adapter is None:
            # 平台上有命令、但本地没有对应适配器：什么都不做（不能 ack 成功——那是撒谎）
            return {"deviceId": device, "polled": 0, "outcomes": [], "note": "no_local_adapter"}
        # FR8：先重投上一轮失败的执行结果（receipt 是闭环的"反馈"腿——丢了就不是
        # at-least-once）。平台按 commandId 幂等接收，重放无副作用。
        # 重投计数进 run 统计（可观测；0 = 无积压，不影响任何既有字段语义）。
        receipt_retry_flushed = self._flush_receipt_retry()
        status, body = self.client.pending(device, limit)
        if status != 200 or not isinstance(body, dict):
            return {
                "deviceId": device,
                "polled": 0,
                "outcomes": [],
                "note": f"pending_failed:{status}",
                "error": (body or {}).get("error") if isinstance(body, dict) else None,
                "receiptRetryFlushed": receipt_retry_flushed,
            }
        commands = [c for c in (body.get("commands") or []) if isinstance(c, dict)]
        stats_extra = {"receiptRetryFlushed": receipt_retry_flushed}
        # NO-62b：按优先级再排一次（纵深防御）。`stop` 必须最先执行；
        # 平台的顺序若与本地排序不一致 → 显式上报，绝不静默接受。
        ordered = sorted(
            commands,
            key=lambda c: (command_priority(c.get("commandKey")), str(c.get("sentAt") or "")),
        )
        platform_keys = [str(c.get("commandId") or "") for c in commands]
        local_keys = [str(c.get("commandId") or "") for c in ordered]
        order_violation = platform_keys != local_keys
        if order_violation:
            logger.warning(
                "平台投递顺序与本地优先级排序不一致（按优先级重排执行）device=%s platform=%s local=%s",
                device,
                platform_keys,
                local_keys,
            )
        outcomes = []
        for command in ordered:
            outcomes.append(self._handle(adapter, device, command))
        result = {
            "deviceId": device,
            "polled": len(ordered),
            "outcomes": outcomes,
            "queuedOnPlatform": body.get("queued"),
            "revokedOnPlatform": body.get("revoked"),
            "checkedAt": body.get("checkedAt"),
            "receiptRetryFlushed": receipt_retry_flushed,
        }
        result.update(stats_extra)
        if order_violation:
            # 观测型：顺序被本地纠正，但这是一条**事实**（平台排序可能退化），必须可查。
            result["platformOrderViolation"] = {
                "platform": platform_keys,
                "local": local_keys,
            }
        return result

    def _enqueue_receipt_retry(
        self, command_id: str, command_key: str, result: str, receipt_body: dict, fingerprint: Any
    ) -> None:
        entry = {
            "commandId": command_id,
            "commandKey": command_key,
            "result": result,
            "receiptBody": receipt_body,
            "fingerprint": fingerprint,
        }
        if len(self._receipt_retry.entries) >= self.receipt_retry_max:
            self._receipt_retry.overflow(entry)
            self.receipt_retry_dropped += 1
            logger.warning(
                "receipt 重投队列溢出（>=%s），转入死信并计数留痕: commandId=%s",
                self.receipt_retry_max,
                command_id,
            )
            return
        self._receipt_retry.append(entry)

    @staticmethod
    def _is_retryable_receipt_status(status: int) -> bool:
        """只重试“结果未知或服务端暂时不可用”的回执；确定性 4xx 不盲目重放。"""
        return status == 0 or status == 429 or status >= 500

    def _flush_receipt_retry(self) -> int:
        """补投失败回执；2xx 出队，瞬时失败保留，确定性 4xx 转入可检查死信。"""
        flushed = 0
        remaining: list[dict] = []
        rejected: list[dict] = []
        for entry in list(self._receipt_retry.entries):
            status, body = self.client.receipt(
                entry["commandId"],
                entry["commandKey"],
                entry["result"],
                entry["receiptBody"],
                authorization_fingerprint=entry["fingerprint"],
            )
            if status in (200, 201):
                flushed += 1
            elif self._is_retryable_receipt_status(status):
                remaining.append(entry)
            else:
                rejected.append(entry)
        self._receipt_retry.replace(remaining)
        for entry in rejected:
            self._receipt_retry.overflow(entry)
        self.receipt_retry_rejected += len(rejected)
        if rejected:
            logger.error(
                "receipt 确定性拒绝（不重放，转入死信）count=%s lastStatus=%s lastBody=%s",
                len(rejected),
                status,
                body,
            )
        return flushed

    def _handle(self, adapter: Any, device: str, command: dict) -> dict:
        command_id = str(command.get("commandId") or "")
        request_id = str(command.get("requestId") or "")
        command_key = str(command.get("commandKey") or "")
        authorization_ref = str(command.get("authorizationRef") or "")
        # NO-62a：授权范围指纹（平台签发）。缺失 → 记录为"未提供"而不是编一个。
        fingerprint = str(command.get("authorizationFingerprint") or "")
        # 平台侧 payload 只有两种合法形态：JSON 对象或 null（control.service.ts 的
        # validateCommandPayload 对没带参数的命令返回 null，pending 响应即
        # `"payload": null`）。签发材料按 canonicalJson(null) = "null" 参与，因此这里
        # 必须把"缺失/非对象"**如实按 None** 传给验签——归一成 {} 会把材料算成 "{}"，
        # 与平台签发不一致，验签必败：payload 缺失的免审批命令（含安全停机 stop）
        # 全部被 fingerprint_signature_invalid 拒掉（NO-68b 修掉的"安全动作不可达"复发）。
        # 验签的防篡改语义不受影响：签发时 payload 是对象、传输被剥成 null → 材料不符 → 照样拒。
        payload = command.get("payload") if isinstance(command.get("payload"), dict) else None
        if authorization_ref == "":
            return self._reject(command, "authorization_ref_missing")
        # 平台签发规则：授权号必须是 control:<requestId>；不一致 → 不碰设备
        if authorization_ref != f"control:{request_id}":
            return self._reject(
                command, "authorization_ref_mismatch", f"expected control:{request_id}"
            )
        if self.command_keys is not None and command_key not in self.command_keys:
            return self._reject(command, "invalid_command_payload", f"unsupported commandKey {command_key}")
        # ── NO-65a：验签（在**碰设备之前**）─────────────────────────────
        # 平台用密钥签发授权范围指纹；本机持同一密钥即可验证"这条命令的范围与内容
        # 确实是平台签发的、且没有被中转环节改写"。验不过 → 拒绝投递且不碰设备。
        scope = command.get("authorizationScope") if isinstance(command.get("authorizationScope"), dict) else {}
        verification_ok, verification_reason = verify_authorization_fingerprint(
            command.get("authorizationFingerprint"),
            request_id=scope.get("requestId", request_id),
            device_id=scope.get("deviceId", device),
            command_key=scope.get("commandKey", command_key),
            approval_instance_id=scope.get("approvalInstanceId"),
            payload=payload,
            secret=self.fingerprint_secret,
            # NO-68b：判"范围不可重建"看**平台有没有下发 authorizationScope**，
            # 不看有没有审批实例号——免审批命令（含安全停机 stop）本就没有审批实例，
            # 而两侧都把缺失项算成空串，材料完全可重建。
            scope_present=bool(scope),
        )
        if verification_ok and scope:
            # 范围自证：签名覆盖的设备号必须就是**本机**、也就是请求里的设备（防跨设备重放）。
            scope_device = str(scope.get("deviceId") or "")
            if scope_device and scope_device != device:
                return self._reject(
                    command,
                    "fingerprint_signature_invalid",
                    f"授权范围设备号 {scope_device} 与本机 {device} 不一致",
                )
        delivery_note = None
        if not verification_ok:
            if verification_reason == "fingerprint_secret_missing":
                # 漏配密钥：如实标注但**不阻断**（否则现场漏配即全线停摆）。
                delivery_note = verification_reason
            else:
                return self._reject(
                    command,
                    verification_reason or "fingerprint_signature_invalid",
                    "授权范围签名验证失败（内容/范围与平台签发不一致）",
                )
        # 安全顺序：授权确认和平台撤回复核必须在设备动作前完成。
        # ack 结果未知或被拒绝时不碰设备；确认成功后的执行失败仍如实回执 failed。
        ack_status, ack_body = self.client.ack(
            command_id,
            True,
            details={
                "authorizationCheckedBeforeAction": True,
                # NO-65a：把验签结论写进投递确认（"验过"与"没验"必须可区分）。
                "fingerprintScheme": "hmac-sha256:v2"
                if str(fingerprint).startswith("hmac-sha256:v2:")
                else ("fnv1a64:v1" if fingerprint else "none"),
                # 验签结论只看"验没验过"：v1 一致性核对不需要 scope 也能验。
                "fingerprintVerified": bool(verification_ok),
                "fingerprintNote": delivery_note,
            },
            authorization_fingerprint=fingerprint or None,
        )
        ack_rejected = ack_status == 409
        if ack_rejected:
            logger.warning(
                "平台拒绝了投递确认（授权复核未通过）device=%s command=%s body=%s",
                device,
                command_key,
                ack_body,
            )
            return {
                "commandId": command_id,
                "requestId": request_id,
                "commandKey": command_key,
                "outcome": "delivery_rejected_by_platform",
                "ackStatus": ack_status,
                "ackBody": ack_body,
            }
        if ack_status not in (200, 201):
            logger.warning(
                "平台授权确认未成功（不碰设备）device=%s command=%s status=%s body=%s",
                device,
                command_key,
                ack_status,
                ack_body,
            )
            return {
                "commandId": command_id,
                "requestId": request_id,
                "commandKey": command_key,
                "outcome": "authorization_ack_unresolved",
                "ackStatus": ack_status,
                "ackBody": ack_body,
            }

        try:
            result = adapter.send_command(command_key, authorization_ref, payload)
        except Exception as exc:
            # 适配器契约要求返回结构化失败，但真实驱动/序列化仍可能在“已 ack、
            # 待执行”的临界段抛错。这里不能让异常吞掉回执：把可审计的 failed
            # 结果送回平台；若上行也失败，继续进入持久重投队列。
            logger.exception(
                "执行器适配器异常 device=%s command=%s reason=%s",
                device,
                command_key,
                exc,
            )
            result = {
                "accepted": False,
                "reason": f"adapter_error:{type(exc).__name__}",
                "state": {},
                "at": None,
            }
        accepted = bool(result.get("accepted"))
        receipt_result = "executed" if accepted else "failed"
        receipt_body = {
            "deviceId": device,
            "commandKey": command_key,
            "adapterAccepted": accepted,
            "adapterReason": result.get("reason"),
            "state": (result.get("state") or {}).get("state"),
            "reportedAt": result.get("at"),
        }
        receipt_status, receipt_ack = self.client.receipt(
            command_id,
            command_key,
            receipt_result,
            receipt_body,
            authorization_fingerprint=fingerprint or None,
        )
        if receipt_status not in (200, 201):
            # 所有非 2xx 先持久记账：瞬时失败下轮重投；确定性拒绝由补投阶段转入死信。
            # 不能在这里凭 HTTP 状态直接丢弃，否则边缘崩溃前连"平台为什么拒绝"都没留住。
            self._enqueue_receipt_retry(command_id, command_key, receipt_result, receipt_body, fingerprint)
        outcome = "executed" if accepted else "execution_failed"
        if not accepted:
            logger.warning(
                "命令执行失败 device=%s command=%s reason=%s", device, command_key, result.get("reason")
            )
        return {
            "commandId": command_id,
            "requestId": request_id,
            "commandKey": command_key,
            "outcome": outcome,
            "adapterReason": result.get("reason"),
            "authorizationFingerprint": fingerprint or None,
            "ackStatus": ack_status,
            "ackBody": ack_body,
            "receiptStatus": receipt_status,
            "receiptBody": receipt_ack,
        }


def build_agent(
    platform_url: str,
    ingest_key: str,
    device_ids: list[str],
    *,
    org_id: str | None = None,
    source_type: str = "simulated",
    hz: float = 1.0,
    timeout: float = 10.0,
    transport: str = "simulated",
    modbus_host: str = "127.0.0.1",
    modbus_port: int = 502,
    modbus_timeout: float = 2.0,
    fingerprint_secret: str | None = None,
    receipt_journal_path: str | None = None,
) -> ControlAgent:
    """按设备号构造命令代理。

    `transport`（NO-62d）：
    - `simulated`（缺省）：数字孪生 AGV（`SimulatedActuatorAdapter`）；
    - `modbus`：`ModbusTcpActuatorTransport` 主站 + `ActuatorAdapter`（授权判定顺序不变）。
      指向真机时把 `source_type` 设为 `real`——**来源隔离是数据可信的前提**，
      不能让"模拟数据"和"真机数据"在平台侧不可区分。
    """
    if transport == "modbus":
        from edge_platform.edge.adapters.actuator.adapter import ActuatorAdapter
        from edge_platform.edge.adapters.actuator.modbus import ModbusTcpActuatorTransport

        adapters = {
            device_id: ActuatorAdapter(
                device_id,
                source_type=source_type,
                model="MODBUS-TCP",
                transport=ModbusTcpActuatorTransport(
                    modbus_host,
                    device_id,
                    port=modbus_port,
                    timeout=modbus_timeout,
                ),
                tick_on_read=False,
            )
            for device_id in device_ids
        }
        for adapter in adapters.values():
            adapter.start()
        client = ControlDownlinkClient(
            platform_url, ingest_key, org_id=org_id, timeout=timeout
        )
        return ControlAgent(
            client,
            adapters,
            fingerprint_secret=fingerprint_secret,
            receipt_journal_path=receipt_journal_path,
        )

    from edge_platform.edge.adapters.actuator.simulated import SimulatedActuatorAdapter

    adapters = {
        device_id: SimulatedActuatorAdapter(device_id, hz=hz, source_type=source_type)
        for device_id in device_ids
    }
    for adapter in adapters.values():
        adapter.start()
    client = ControlDownlinkClient(
        platform_url, ingest_key, org_id=org_id, timeout=timeout
    )
    return ControlAgent(
        client,
        adapters,
        fingerprint_secret=fingerprint_secret,
        receipt_journal_path=receipt_journal_path,
    )


__all__ = [
    "DELIVERY_REASONS",
    "ControlAgent",
    "ControlDownlinkClient",
    "build_agent",
]
