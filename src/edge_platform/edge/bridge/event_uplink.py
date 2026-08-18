"""Edge→Cloud 事件上行（NO-04b：Catalog 信封事件批量上行 + 离线缓冲）。

EventUplink 订阅 STREAM_EVENTS（规则事件 / 世界投影 EntityDeclared /
EntityStateObserved 等 Catalog 信封事件），批量（≤100）POST 到云侧
POST /api/ingest/events（ADR-009 信封 + 传输级 (org,source,eventId) 幂等去重）：

- 信封契约校验（validate_envelope fail-closed，非法不发送并计数）；
- 离线缓冲 + 跨重启断点续传（NO-04c）：未发送信封持久化到 queue_path 侧车
  文件（JSONL 追加 + 原子重写，兼容旧 JSON 数组格式），启动时加载、入队即
  落盘、发送成功后截断——边缘进程重启/崩溃不丢未发送批次（本地事件库
  risk_event 不存 envelope 字段，故队列文件是信封的持久载体）；加载损坏
  显式 ERROR（以空队列启动，绝不静默）；
- 幂等重放安全：云端按 (org, source, event_id) 去重，重试重复投递不重复落账
  （这正是传输级去重的意义：发送端可以做 at-least-once）。

2026-08-19 审计 P1 整改（两项）：
- 毒信封 dead-letter：此前失败批次无限塞回队头——若队头信封被云端持续
  拒绝（4xx），后续所有批次被永久阻塞。现在云端 4xx（非 429）拒绝或同批
  连续失败 ≥ MAX_BATCH_ATTEMPTS 次时，队头批次转入 <queue_path>.dead-letter
  JSONL（人工重放载体），后续批次继续上行；stats.dead_lettered 计数。
- 离线缓冲有界 + O(1) 落盘：此前缓冲无上限且每次入队全量 json.dump 重写
  队列文件（O(n²) 写放大）。现在缓冲以 MAX_BUFFER 为界（满时丢最旧并计数
  dropped_overflow），入队改为 JSONL 单行追加（O(1)，崩溃安全——尾部半行
  加载时显式跳过），全量重写仅发生在发送成功/dead-letter/文件压实时
  （摊销 O(1)/条；文件长度以 2×MAX_BUFFER 为界周期压实）。

配置（config.Settings）：EWOH_EVENT_UPLINK_URL（空 = 上行关闭，显式打印）、
EWOH_EVENT_UPLINK_KEY（X-Ingest-Key）、EWOH_EVENT_UPLINK_ORG_ID（X-Org-Id）；
queue_path 由 run.py 传入（<db>.uplink-queue.json）。

纯 Python 标准库实现。
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from typing import Any

from edge_platform.contracts import envelope as envelope_contract
from edge_platform.contracts.event_catalog import EVENT_CATALOG_TYPES

logger = logging.getLogger("ewoh.bridge.event_uplink")

BATCH_SIZE = 100
MAX_BACKOFF_SEC = 60
CATALOG_TYPES: frozenset = frozenset(EVENT_CATALOG_TYPES)
# P1（2026-08-19 审计）：离线缓冲上限——满时丢最旧（dropped_overflow 计数），
# 云端长时间不可达时内存/磁盘不再无界增长。
MAX_BUFFER = 10_000
# P1（2026-08-19 审计）：队头连续失败上限——达到即剔除队头一条转 dead-letter
#（毒信封不再永久阻塞队头）。阈值经退避累计约 5 分钟（2+4+8+16+32+60×5），
# 远超常见瞬态抖动，只拦截真正卡死的队头。
MAX_BATCH_ATTEMPTS = 10


def _runtime_mode() -> str:
    """读取运行时模式（EDGE-041：production 判定；读取失败按 development 宽松）。"""
    try:
        from edge_platform.config import Settings

        return Settings.load().runtime_mode
    except Exception:
        return "development"


class EventUplink:
    """STREAM_EVENTS → 云侧 /api/ingest/events 批量上行（持久化离线缓冲 + 退避）。"""

    def __init__(
        self,
        bus,
        spark_url: str,
        ingest_key: str = "",
        org_id: str = "",
        batch_size: int = BATCH_SIZE,
        queue_path: str = "",
    ):
        self._bus = bus
        self._url = spark_url.rstrip("/") + "/api/ingest/events"
        self._ingest_key = ingest_key
        self._org_id = org_id
        self._batch_size = max(1, min(batch_size, BATCH_SIZE))
        self._queue_path = queue_path or ""
        # EDGE-041（2026-08-17 审计整改）：production 下 X-Ingest-Key 禁止经
        # 明文 http 传输——上行地址必须为 https://，否则本组件显式禁用
        # （enabled=false，health 说明原因），绝不降级发送凭据。
        # （mTLS/HMAC 签名属云端协同改造，由云侧任务域跟进；此处先消除明文面。）
        self._disabled_reason = ""
        if self._url.startswith(("http://", "//")) and _runtime_mode() == "production":
            self._disabled_reason = "insecure_http_in_production"
            logger.error(
                "event uplink: production 下拒绝明文 http 上行（X-Ingest-Key 会暴露），已禁用: %s",
                self._url,
            )
        self._buffer: deque[dict] = deque()
        # NO-04c：断点续传——启动加载未发送队列；损坏显式 ERROR（空队列启动，不静默）。
        if self._queue_path and os.path.exists(self._queue_path):
            loaded = self._load_queue()
            if len(loaded) > MAX_BUFFER:
                dropped = len(loaded) - MAX_BUFFER
                self._buffer = deque(loaded[len(loaded) - MAX_BUFFER :])
                logger.warning(
                    "event uplink: 队列恢复 %d 条超上限，丢弃最旧 %d 条（dropped_overflow）",
                    len(loaded),
                    dropped,
                )
            else:
                self._buffer = deque(loaded)
            logger.info("event uplink: 队列恢复 %d 条（%s）", len(self._buffer), self._queue_path)
            if len(self._buffer) != len(loaded):
                # 载入即压实：文件与有界缓冲对齐
                self._persist()
        self._file_count = len(self._buffer)
        self._lock = threading.Lock()
        self._running = False
        self._thread: threading.Thread | None = None
        self._sub_id = None
        self._consecutive_failures = 0
        self._batch_attempts = 0
        self._stats = {
            "sent": 0,
            "buffered": 0,
            "dropped_invalid": 0,
            "dropped_overflow": 0,
            "dead_lettered": 0,
            "failures": 0,
        }

    def _load_queue(self) -> list[dict]:
        """加载磁盘队列：当前 JSONL 格式 + 兼容旧 JSON 数组格式。

        JSONL 尾部半行（崩溃残留于 append 中途）显式计数跳过——append 模式
        下单行损坏不影响其余行（对比旧全量重写：损坏即整文件作废）。
        """
        try:
            with open(self._queue_path, encoding="utf-8") as fh:
                text = fh.read()
        except Exception as exc:
            logger.error("event uplink: 队列加载失败（以空队列启动）: %s", exc)
            return []
        stripped = text.strip()
        if stripped.startswith("["):
            # 旧格式：整个文件是一个 JSON 数组（全量重写时代的产物）
            try:
                parsed = json.loads(stripped)
            except json.JSONDecodeError:
                logger.error("event uplink: 队列文件损坏（JSON 数组解析失败，以空队列启动）")
                return []
            return [e for e in parsed if isinstance(e, dict)]
        envelopes: list[dict] = []
        truncated_tail = 0
        for line in text.splitlines():
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                truncated_tail += 1
                continue
            if isinstance(obj, dict):
                envelopes.append(obj)
        if truncated_tail:
            logger.warning("event uplink: 队列文件尾部 %d 条半行跳过（崩溃残留）", truncated_tail)
        return envelopes

    @property
    def enabled(self) -> bool:
        return bool(self._url) and not self._disabled_reason

    def health(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "url": self._url,
            "disabled_reason": self._disabled_reason or None,
            "stats": dict(self._stats),
            "buffer": len(self._buffer),
            "queue_path": self._queue_path,
        }

    def _persist(self) -> None:
        """队列全量重写（JSONL；tmp + rename 原子替换）。

        仅在发送成功/dead-letter/载入压实时调用（摊销 O(1)/条）；入队路径
        用 _append_file 的 O(1) 单行追加（P1：消除逐入队全量重写的 O(n²)）。
        """
        if not self._queue_path:
            return
        tmp = f"{self._queue_path}.tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as fh:
                for env in self._buffer:
                    fh.write(json.dumps(env, ensure_ascii=False) + "\n")
            os.replace(tmp, self._queue_path)
            self._file_count = len(self._buffer)
        except Exception as exc:
            logger.error("event uplink: 队列持久化失败: %s", exc)

    def _append_file(self, envelope: dict) -> None:
        """单行追加落盘（NO-04c 入队即落盘的 O(1) 实现路径）。"""
        if not self._queue_path:
            return
        try:
            with open(self._queue_path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(envelope, ensure_ascii=False) + "\n")
            self._file_count += 1
        except Exception as exc:
            logger.error("event uplink: 队列追加失败: %s", exc)

    def _dead_letter_path(self) -> str:
        return f"{self._queue_path}.dead-letter.jsonl"

    def _dead_letter(self, batch: list[dict], reason: str) -> None:
        """P1（2026-08-19 审计）：毒信封转死信——反复失败/被云端 4xx 拒绝的
        队头批次追加到 <queue_path>.dead-letter.jsonl（人工重放载体；云端按
        (org,source,eventId) 幂等去重，重放安全），不再永久阻塞队头。"""
        self._stats["dead_lettered"] += len(batch)
        if not self._queue_path:
            logger.error(
                "event uplink: 批次转 dead-letter（无队列路径，仅计数）: %d 条，原因: %s",
                len(batch),
                reason,
            )
            return
        try:
            with open(self._dead_letter_path(), "a", encoding="utf-8") as fh:
                for env in batch:
                    fh.write(json.dumps(env, ensure_ascii=False) + "\n")
            logger.error(
                "event uplink: 批次 %d 条转 dead-letter（%s）: %s",
                len(batch),
                reason,
                self._dead_letter_path(),
            )
        except Exception as exc:
            # 死信写盘失败也不能回退成永久阻塞队头——保留计数即丢弃（留痕日志可查）
            logger.error("event uplink: dead-letter 写入失败（丢弃计数）: %s", exc)

    def start(self) -> None:
        if self._running:
            return
        if self._disabled_reason:  # EDGE-041：production 明文 http → 拒绝启动
            logger.error("event uplink: 已禁用（%s），start() 不生效", self._disabled_reason)
            return
        self._running = True
        self._sub_id = self._bus.subscribe("events", self._enqueue)
        self._thread = threading.Thread(target=self._loop, daemon=True, name="event-uplink")
        self._thread.start()

    def stop(self) -> None:
        self._running = False

    def _enqueue(self, evt: dict) -> None:
        """STREAM_EVENTS 回调：契约校验后入缓冲（fail-closed，非法计数不发送）。"""
        envelope = evt.get("envelope") if isinstance(evt, dict) else None
        if not isinstance(envelope, dict):
            self._stats["dropped_invalid"] += 1
            return
        errors = envelope_contract.validate_envelope(envelope, CATALOG_TYPES)
        if errors:
            logger.warning("event uplink: 信封契约校验失败（不发送）: %s", errors)
            self._stats["dropped_invalid"] += 1
            return
        with self._lock:
            if len(self._buffer) >= MAX_BUFFER:
                # P1：有界缓冲——满时丢最旧（等待最久），新事件优先；
                # 丢弃计数进 health.stats.dropped_overflow。
                self._buffer.popleft()
                self._stats["dropped_overflow"] += 1
            self._buffer.append(envelope)
            self._stats["buffered"] += 1
            self._append_file(envelope)  # NO-04c：入队即落盘（O(1) 追加）
            if self._file_count > 2 * MAX_BUFFER:
                # 文件压实：回收已丢弃/已发送的旧行，文件长度有界
                self._persist()

    def _loop(self) -> None:
        while self._running:
            batch = self._drain()
            if batch:
                outcome = self._post_batch(batch)
                if outcome == "ok":
                    self._stats["sent"] += len(batch)
                    self._consecutive_failures = 0
                    self._batch_attempts = 0
                    with self._lock:
                        self._persist()  # 成功即截断队列文件
                else:
                    self._stats["failures"] += 1
                    self._consecutive_failures += 1
                    self._batch_attempts += 1
                    if outcome == "dead_letter" or self._batch_attempts >= MAX_BATCH_ATTEMPTS:
                        # P1：毒信封 dead-letter——只剔除队头一条（最小损失面：
                        # 无法定位批内哪条有毒，逐条浮出逐条剔除，批内无辜信封
                        # 保留正常投递机会），队头不再永久阻塞。
                        reason = (
                            "云端 4xx 拒绝"
                            if outcome == "dead_letter"
                            else f"连续失败 {self._batch_attempts} 次"
                        )
                        self._dead_letter(batch[:1], reason)
                        self._batch_attempts = 0
                        rest = batch[1:]
                        if rest:
                            with self._lock:
                                self._buffer.extendleft(reversed(rest))
                        with self._lock:
                            self._persist()  # 死信条目从队列文件截断
                    else:
                        # 瞬态失败：批次重新放回缓冲头部（at-least-once，云端幂等
                        # 去重兜底；队列文件仍保留完整未发送集合，重启后继续续传）
                        with self._lock:
                            self._buffer.extendleft(reversed(batch))
                    self._backoff()
            else:
                self._batch_attempts = 0
                time.sleep(1.0)

    def _drain(self) -> list[dict]:
        with self._lock:
            batch: list[dict] = []
            while self._buffer and len(batch) < self._batch_size:
                batch.append(self._buffer.popleft())
            return batch

    def _post_batch(self, batch: list[dict]) -> str:
        """POST 一个批次。返回 "ok" / "retry"（瞬态失败）/ "dead_letter"（云端
        4xx 永久拒绝——重试无意义，P1：立即转死信而非无限重试）。"""
        body = json.dumps({"events": batch}).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self._ingest_key:
            headers["X-Ingest-Key"] = self._ingest_key
        if self._org_id:
            headers["X-Org-Id"] = self._org_id
        req = urllib.request.Request(self._url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:  # nosec B310 - configured internal HTTP client
                if 200 <= resp.status < 300:
                    return "ok"
                logger.warning("event uplink: 上行非 2xx 响应 %d（重试）", resp.status)
                return "retry"
        except urllib.error.HTTPError as exc:
            if 400 <= exc.code < 500 and exc.code != 429:
                # 云端已校验并拒绝（契约/权限类）——重试不会成功，转死信
                logger.warning("event uplink: 云端 4xx 拒绝（%d），批次转 dead-letter", exc.code)
                return "dead_letter"
            logger.warning("event uplink: 上行 HTTP %d（重试）", exc.code)
            return "retry"
        except urllib.error.URLError as exc:
            logger.warning("event uplink: 上行失败 %s（重试）", exc)
            return "retry"

    def _backoff(self) -> None:
        delay = min(2 ** min(self._consecutive_failures, 6), MAX_BACKOFF_SEC)
        time.sleep(delay)


__all__ = ["EventUplink"]
