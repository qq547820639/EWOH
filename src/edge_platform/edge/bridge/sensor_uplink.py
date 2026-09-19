"""多源传感器帧上行：STREAM_SENSOR_FRAMES → 云侧 /api/ingest/*（按类路由）。

为什么需要它
------------
边缘此前只有**外骨骼**帧能上行（`edge_to_spark.py`）与**信封事件**上行
（`event_uplink.py`）。环境/摄像头/定位三类适配器即使采到帧也只能落在边缘本地，
平台侧 `/api/ingest/environment`、`/api/ingest/camera`、`/api/ingest/location`
三个已实现的入口从来没有被边缘喂过——"感知层"在平台上只有外骨骼一条腿。
本模块消费 `AdapterManager` 发布的**归一化帧信封**
（`edge/modeling/sensor_frames.normalize_frame` 的输出），按 `uplink.endpoint`
路由投递，三类传感器数据由此真正进入工厂世界模型。

与 `event_uplink.py` 同族的韧性语义（刻意保持一致，避免两套心跳）
----------------------------------------------------------------
- 有界缓冲（`MAX_BUFFER`，满时丢最旧 + `dropped_overflow` 计数）；
- 入队即落盘（JSONL 单行追加，O(1)、崩溃安全：尾部半行加载时跳过）；
- 离线缓冲 + 跨重启断点续传（启动加载队列并继续发送）；
- 发送成功/死信时才全量压实（摊销 O(1)/条）；
- 4xx（非 429）→ dead-letter 文件 + 计数，**不再永久阻塞队头**；
  5xx / 429 / 网络错误 → 指数退避重试（at-least-once）；
- production 下 `X-Ingest-Key` 禁止明文 http（与事件上行同一 EDGE-041 判定）。

幂等
----
平台侧 environment / camera / location 已按 `(org_id, scope, record_id)` 认领
（`SensorIngestService.claimRecord`），外骨骼按 `raw_ref` 去重。因此本桥只保证
at-least-once：重放不会双写，`skipped` 计入 `duplicates`。

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
import uuid
from collections import deque
from typing import Any

from edge_platform.runtime.protocols import STREAM_SENSOR_FRAMES

logger = logging.getLogger("ewoh.bridge.sensor_uplink")

#: 单次请求最大帧数（平台外骨骼批量端点上限 100）。
BATCH_SIZE = 100
#: 退避上限（秒）。
MAX_BACKOFF_SEC = 60
#: 离线缓冲上限：满时丢最旧（dropped_overflow 计数），磁盘/内存有界。
MAX_BUFFER = 10_000
#: 明细记录 id 保留上限（可观测/事后核对；超出只计数不留明细，避免内存无界）。
MAX_RECORD_ID_TRACE = 1_000


def _runtime_mode() -> str:
    """读取运行时模式（读取失败按 development 宽松，与 event_uplink 一致）。"""
    try:
        from edge_platform.config import Settings

        return Settings.load().runtime_mode
    except Exception:
        return "development"


class SensorUplinkBridge:
    """归一化传感器帧 → 平台 ingest 端点（按类路由 + 离线缓冲 + 死信）。"""

    def __init__(
        self,
        bus,
        spark_url: str,
        ingest_key: str = "",
        org_id: str = "",
        queue_path: str = "",
        batch_size: int = BATCH_SIZE,
        timeout_sec: float = 5.0,
        opener=None,
        include_exoskeleton: bool = False,
    ):
        self._bus = bus
        # UR8（2026-09-13 审查）：先 strip——urlsplit/urllib 容忍 URL 前后空白
        # （" http://host" 照常发往 http），不 strip 则下方明文 http 守卫被空白
        # 绕过，production 下 X-Ingest-Key 仍走明文。
        self._base_url = (spark_url or "").strip().rstrip("/")
        self._ingest_key = ingest_key
        self._org_id = org_id
        self._queue_path = queue_path or ""
        self._batch_size = max(1, min(int(batch_size), BATCH_SIZE))
        self._timeout_sec = timeout_sec
        #: 是否接管外骨骼帧。缺省 False：外骨骼另有 `edge_to_spark.py`（含设备侧
        #: BACKFILL 补传语义），两条通道同时上行同一帧会放大流量（平台虽按
        #: raw_ref/record_id 幂等，但没必要）；需要统一通道时显式开启。
        self._include_exoskeleton = include_exoskeleton
        #: 可注入的 HTTP 打开器（测试用；缺省 urllib.request.urlopen）
        self._opener = opener or urllib.request.urlopen
        self._disabled_reason = ""
        # UR8：scheme 大小写不敏感（RFC 3986）——先归一再判定，堵 "HTTP://" 旁路。
        if self._base_url.lower().startswith(("http://", "//")) and _runtime_mode() == "production":
            self._disabled_reason = "insecure_http_in_production"
            logger.error(
                "sensor uplink: production 下拒绝明文 http 上行（X-Ingest-Key 会暴露），已禁用: %s",
                self._base_url,
            )
        self._buffer: deque[dict] = deque()
        self._lock = threading.Lock()
        self._running = False
        self._thread: threading.Thread | None = None
        self._sub_id = None
        self._consecutive_failures = 0
        self._stats = {
            "received": 0,
            "sent": 0,
            "duplicates": 0,
            "rejected": 0,
            "retried": 0,
            "dropped_invalid": 0,
            "dropped_overflow": 0,
            "replayed": 0,
            "skipped_exoskeleton": 0,
            # 按端点的细分计数（哪个类别在丢/被拒，一眼可见）
            "by_endpoint": {},
            # 最近的成功/被拒记录 id（上限 MAX_RECORD_ID_TRACE）：运维可据此重放，
            # 事后可核对"平台里到底有没有这条"。
            "sent_record_ids": [],
            "rejected_record_ids": [],
        }
        if self._queue_path and os.path.exists(self._queue_path):
            loaded = self._load_queue()
            if len(loaded) > MAX_BUFFER:
                dropped = len(loaded) - MAX_BUFFER
                self._buffer = deque(loaded[dropped:])
                self._stats["dropped_overflow"] += dropped
                logger.warning(
                    "sensor uplink: 队列恢复 %d 条超上限，丢弃最旧 %d 条（dropped_overflow）",
                    len(loaded),
                    dropped,
                )
                self._persist()
            else:
                self._buffer = deque(loaded)
            self._stats["replayed"] = len(self._buffer)
            if self._buffer:
                logger.info("sensor uplink: 队列恢复 %d 条（%s）", len(self._buffer), self._queue_path)

    # ---- 生命周期 ----
    @property
    def enabled(self) -> bool:
        return bool(self._base_url) and not self._disabled_reason

    def health(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "url": self._base_url,
            "disabled_reason": self._disabled_reason or None,
            "stats": dict(self._stats),
            "buffer": len(self._buffer),
            "queue_path": self._queue_path,
        }

    def start(self) -> None:
        if self._running:
            return
        if self._disabled_reason:
            logger.error("sensor uplink: 已禁用（%s），start() 不生效", self._disabled_reason)
            return
        if not self._base_url:
            logger.info("sensor uplink: 未配置上行地址（EWOH_SENSOR_UPLINK_URL 为空），本组件不启动")
            return
        self._running = True
        self._sub_id = self._bus.subscribe(STREAM_SENSOR_FRAMES, self.enqueue)
        self._thread = threading.Thread(target=self._loop, daemon=True, name="sensor-uplink")
        self._thread.start()

    def stop(self, timeout: float = 2.0) -> None:
        self._running = False
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=timeout)

    def retarget(self, spark_url: str) -> None:
        """切换上行目标（同一实例、同一订阅、同一队列）。

        为什么需要它：模拟/现场都会遇到"先断网、后恢复"。若用"停旧桥 + 起新桥"
        切换，会出现两个问题——订阅空窗期发布的帧无人接收（进程内丢失），
        或两实例同时写同一队列文件（损坏）。retarget 原地切换并把退避清零。

        `spark_url` 为空或与当前相同 = 不做任何事（调用方不必分支）。
        """
        url = (spark_url or "").strip().rstrip("/")
        if not url or url == self._base_url:
            return
        self._base_url = url
        self._disabled_reason = ""
        # UR8：scheme 大小写不敏感（RFC 3986）——与 __init__ 同一口径。
        if url.lower().startswith(("http://", "//")) and _runtime_mode() == "production":
            self._disabled_reason = "insecure_http_in_production"
            logger.error("sensor uplink: retarget 到明文 http（production 拒绝）: %s", url)
        with self._lock:
            self._consecutive_failures = 0
        logger.info("sensor uplink: 上行目标已切换 → %s", url)

    # ---- 入队 / 落盘 ----
    def enqueue(self, frame: dict) -> None:
        """接收入队（bus 订阅回调）：只接受带 `uplink.endpoint/payload` 的归一化信封。"""
        with self._lock:
            self._stats["received"] += 1
        if not self._include_exoskeleton and isinstance(frame, dict):
            uplink = frame.get("uplink")
            if isinstance(uplink, dict) and uplink.get("endpoint") == "exoskeleton":
                with self._lock:
                    self._stats["skipped_exoskeleton"] += 1
                return
        entry = self._to_entry(frame)
        if entry is None:
            with self._lock:
                self._stats["dropped_invalid"] += 1
            logger.error("sensor uplink: 收到非归一化帧（缺 uplink.endpoint/payload），计数丢弃")
            return
        dropped = 0
        with self._lock:
            self._buffer.append(entry)
            while len(self._buffer) > MAX_BUFFER:
                self._buffer.popleft()
                dropped += 1
            if dropped:
                self._stats["dropped_overflow"] += dropped
        if dropped:
            logger.warning("sensor uplink: 缓冲满，丢弃最旧 %d 条（dropped_overflow）", dropped)
            self._persist()
        else:
            self._append_file(entry)

    @staticmethod
    def _to_entry(frame: Any) -> dict | None:
        if not isinstance(frame, dict):
            return None
        uplink = frame.get("uplink")
        if not isinstance(uplink, dict):
            return None
        endpoint = str(uplink.get("endpoint") or "").strip()
        payload = uplink.get("payload")
        if not endpoint or not isinstance(payload, dict):
            return None
        return {
            "_uid": uuid.uuid4().hex,
            "kind": frame.get("kind"),
            "endpoint": endpoint,
            "batch": bool(uplink.get("batch")),
            "record_id": payload.get("record_id") or frame.get("record_id"),
            "payload": payload,
        }

    def _load_queue(self) -> list[dict]:
        """加载 JSONL 队列（尾部半行跳过，损坏显式 ERROR——绝不静默吞）。"""
        try:
            with open(self._queue_path, encoding="utf-8") as fh:
                text = fh.read()
        except Exception as exc:
            logger.error("sensor uplink: 队列加载失败（以空队列启动）: %s", exc)
            return []
        entries: list[dict] = []
        truncated = 0
        for line in text.splitlines():
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                truncated += 1
                continue
            if isinstance(obj, dict) and isinstance(obj.get("payload"), dict) and obj.get("endpoint"):
                obj.setdefault("_uid", uuid.uuid4().hex)
                entries.append(obj)
        if truncated:
            logger.warning("sensor uplink: 队列文件尾部 %d 条半行跳过（崩溃残留）", truncated)
        return entries

    def _append_file(self, entry: dict) -> None:
        if not self._queue_path:
            return
        try:
            # UR8（2026-09-13 审查）：与 _persist 的"快照→写→replace"同锁串行。
            # 否则入队线程在压实快照之后、os.replace 之前把行追加进旧 inode，
            # replace 一落盘该行即被丢弃——进程随即崩溃时这条帧彻底丢失，
            # 违背"入队即落盘（崩溃安全）"承诺（见回归测试
            # test_enqueue_during_compaction_is_not_lost）。
            with self._lock:
                with open(self._queue_path, "a", encoding="utf-8") as fh:
                    fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except Exception as exc:
            logger.error("sensor uplink: 队列追加失败: %s", exc)

    def _persist(self) -> None:
        """全量压实（仅发送成功/死信/丢最旧时调用；tmp + rename 原子替换）。"""
        if not self._queue_path:
            return
        tmp = f"{self._queue_path}.tmp"
        try:
            # UR8：锁必须覆盖快照到 os.replace 全程——只锁快照时，replace 与
            # _append_file 的追加仍可交错（丢行/重复行），见 _append_file 注释。
            # 持锁写盘（≤MAX_BUFFER 行）会短暂阻塞入队线程，换取崩溃安全不变量：
            # "任意时刻，内存缓冲中的每条帧要么已在队列文件里，要么正在写入"。
            with self._lock:
                with open(tmp, "w", encoding="utf-8") as fh:
                    for entry in self._buffer:
                        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
                os.replace(tmp, self._queue_path)
        except Exception as exc:
            logger.error("sensor uplink: 队列持久化失败: %s", exc)

    def _dead_letter_path(self) -> str:
        return f"{self._queue_path}.dead-letter.jsonl" if self._queue_path else ""

    def _trace_ids(self, entry: dict, key: str) -> None:
        """记录 id 明细（有界）；超限只计数不留明细。"""
        record_id = entry.get("record_id")
        if not record_id:
            return
        with self._lock:
            bucket = self._stats[key]
            if len(bucket) < MAX_RECORD_ID_TRACE:
                bucket.append(record_id)

    def _bump(self, endpoint: str, key: str, amount: int = 1) -> None:
        """按端点累加细分计数（调用方自持锁或经 _bump 内部加锁）。"""
        with self._lock:
            bucket = self._stats["by_endpoint"].setdefault(
                endpoint, {"sent": 0, "duplicates": 0, "rejected": 0}
            )
            bucket[key] = int(bucket.get(key, 0)) + amount

    def _dead_letter(self, entries: list[dict], reason: str) -> None:
        """被平台 4xx 拒绝的帧转死信文件（人工重放载体；平台侧幂等，重放安全）。"""
        with self._lock:
            self._stats["rejected"] += len(entries)
        for entry in entries:
            self._bump(str(entry.get("endpoint") or "unknown"), "rejected")
            self._trace_ids(entry, "rejected_record_ids")
        path = self._dead_letter_path()
        if not path:
            logger.error("sensor uplink: %d 条转死信（无队列路径，仅计数），原因: %s", len(entries), reason)
            return
        try:
            with open(path, "a", encoding="utf-8") as fh:
                for entry in entries:
                    fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
            logger.error("sensor uplink: %d 条转死信（%s）: %s", len(entries), reason, path)
        except Exception as exc:
            logger.error("sensor uplink: 死信写入失败（保留计数）: %s", exc)

    # ---- 发送 ----
    def _loop(self) -> None:
        while self._running:
            try:
                progressed = self.flush_once()
            except Exception:
                logger.exception("sensor uplink: flush 异常（继续循环）")
                progressed = False
            if progressed:
                self._consecutive_failures = 0
                continue
            if len(self._buffer) == 0:
                time.sleep(0.2)
                continue
            delay = min(2 ** min(self._consecutive_failures, 6), MAX_BACKOFF_SEC)
            if self._consecutive_failures >= 3:
                logger.error(
                    "sensor uplink: 连续失败 %d 次（缓冲 %d 条），退避 %.0fs",
                    self._consecutive_failures,
                    len(self._buffer),
                    delay,
                )
            time.sleep(delay)

    def flush_once(self) -> bool:
        """尝试投递一轮；返回是否取得进展（成功发送或转死信）。"""
        with self._lock:
            pending = list(self._buffer)
        if not pending:
            return False
        # 每端点每轮一组，组内保持 FIFO 顺序：
        # - 批量端点（外骨骼）：本轮取队头 ≤BATCH_SIZE 条合成一次请求；
        # - 非批量端点：本轮只取**队头一条**（平台没有批量入口；逐条判定成败，
        #   失败时只影响这一条，不会把后面同端点的帧一起卡住）。
        groups: dict[str, list[dict]] = {}
        for entry in pending:
            endpoint = entry["endpoint"]
            if endpoint in groups:
                continue
            if entry.get("batch"):
                groups[endpoint] = [
                    e for e in pending if e["endpoint"] == endpoint
                ][: self._batch_size]
            else:
                groups[endpoint] = [entry]

        progressed = False
        for endpoint, entries in groups.items():
            if not entries:
                continue
            outcome = self._send_group(endpoint, entries)
            if outcome == "retry":
                with self._lock:
                    self._stats["retried"] += len(entries)
                self._consecutive_failures += 1
                continue
            with self._lock:
                sent_uids = {e["_uid"] for e in entries}
                self._buffer = deque(e for e in self._buffer if e["_uid"] not in sent_uids)
            if outcome == "rejected":
                self._dead_letter(entries, "平台拒绝（批量端点，非 429/非可重试）")
            progressed = True
        if progressed:
            self._persist()
        return progressed

    def _send_group(self, endpoint: str, entries: list[dict]) -> str:
        """投递一组同端点帧；返回 ``sent`` / ``rejected`` / ``retry``。

        组内全有或全无：任一帧需要重试即整组重试（帧按 record_id 幂等，
        重复投递安全；平台侧的 `skipped` 计入 duplicates）。
        """
        if entries[0].get("batch"):
            body = {"frames": [e["payload"] for e in entries]}
            status, payload = self._post(f"/api/ingest/{endpoint}/batch", body)
        else:
            # 非批量端点：逐帧 POST（平台未提供批量入口），失败即整组重试。
            sent_any = False
            for entry in entries:
                status, payload = self._post(f"/api/ingest/{endpoint}", entry["payload"])
                verdict = self._classify(status, payload)
                if verdict == "retry":
                    return "retry"
                if verdict == "rejected":
                    # 单帧被拒：只把该帧转死信，其余继续。
                    self._dead_letter([entry], self._reject_reason(status, payload))
                    with self._lock:
                        self._buffer = deque(e for e in self._buffer if e["_uid"] != entry["_uid"])
                    sent_any = True
                    continue
                if verdict == "duplicate":
                    with self._lock:
                        self._stats["duplicates"] += 1
                    self._bump(endpoint, "duplicates")
                else:
                    with self._lock:
                        self._stats["sent"] += 1
                    self._bump(endpoint, "sent")
                    self._trace_ids(entry, "sent_record_ids")
                sent_any = True
            if sent_any:
                self._persist()
            # 逐帧路径已就地处理，整组视为已取得进展（避免重复计数/重复移除）。
            return "sent"

        verdict = self._classify(status, payload)
        if verdict == "retry":
            return "retry"
        if verdict == "rejected":
            return "rejected"
        # 2026-09-15 仿真对抗发现：批量端点（/api/ingest/exoskeleton/batch）返回
        # 201 + 逐帧 results，此前整组按 HTTP 结果一口径计数——平台逐帧拒绝
        # （如 CLOCK_DRIFT_FUTURE_TS）被桥记成 sent，账目失真。现按 results[]
        # 逐帧分类：accepted=true → sent；accepted=false&skipped=true → duplicate；
        # accepted=false → rejected + 单帧死信。results 缺失/错位时退回整组口径。
        results = payload.get("results") if isinstance(payload, dict) else None
        if isinstance(results, list) and len(results) == len(entries):
            sent_n = dup_n = 0
            dead: list[dict] = []
            for entry, item in zip(entries, results):
                if not isinstance(item, dict):
                    sent_n += 1
                    continue
                rid_ok = (
                    item.get("record_id") is None
                    or entry.get("record_id") is None
                    or str(item.get("record_id")) == str(entry.get("record_id"))
                )
                if not rid_ok:
                    sent_n += 1  # results 与请求错位：退回乐观口径，不误判
                    continue
                if item.get("accepted") is False and item.get("skipped") is True:
                    dup_n += 1
                elif item.get("accepted") is False:
                    dead.append(entry)
                else:
                    sent_n += 1
                    self._trace_ids(entry, "sent_record_ids")
            with self._lock:
                self._stats["sent"] += sent_n
                self._stats["duplicates"] += dup_n
            self._bump(endpoint, "sent", sent_n)
            self._bump(endpoint, "duplicates", dup_n)
            if dead:
                # rejected 的总数/分端点计数由 _dead_letter 内部累加（不要重复计）
                self._dead_letter(dead, "batch_item_rejected")
                with self._lock:
                    dead_uids = {e["_uid"] for e in dead}
                    self._buffer = deque(e for e in self._buffer if e["_uid"] not in dead_uids)
            self._persist()
            return "sent"
        with self._lock:
            if verdict == "duplicate":
                self._stats["duplicates"] += len(entries)
            else:
                self._stats["sent"] += len(entries)
        self._bump(endpoint, "duplicates" if verdict == "duplicate" else "sent", len(entries))
        if verdict != "duplicate":
            for entry in entries:
                self._trace_ids(entry, "sent_record_ids")
        return "sent"

    def _post(self, path: str, body: dict) -> tuple[int, dict | None]:
        url = f"{self._base_url}{path}"
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self._ingest_key:
            headers["X-Ingest-Key"] = self._ingest_key
        if self._org_id:
            headers["X-Org-Id"] = self._org_id
        request = urllib.request.Request(url, data=data, headers=headers, method="POST")
        try:
            with self._opener(request, timeout=self._timeout_sec) as response:
                raw = response.read().decode("utf-8", errors="replace")
                status = int(getattr(response, "status", 200) or 200)
        except urllib.error.HTTPError as exc:
            raw = ""
            try:
                raw = exc.read().decode("utf-8", errors="replace")
            except Exception:
                raw = ""
            return int(exc.code), self._parse(raw)
        except Exception as exc:
            logger.warning("sensor uplink: 请求失败（将重试）: %s %s: %s", path, type(exc).__name__, exc)
            return 0, None
        return status, self._parse(raw)

    @staticmethod
    def _reject_reason(status: int, payload: dict | None) -> str:
        """死信原因（可读且如实）：HTTP 状态 + 平台给的原因。"""
        detail = ""
        if isinstance(payload, dict) and payload.get("error"):
            detail = f"：{str(payload['error'])[:200]}"
        if 400 <= status < 500:
            return f"平台 HTTP {status} 拒绝{detail}"
        return f"平台显式拒绝（HTTP {status}）{detail}"

    @staticmethod
    def _parse(raw: str) -> dict | None:
        if not raw:
            return None
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return None
        return parsed if isinstance(parsed, dict) else None

    @staticmethod
    def _classify(status: int, payload: dict | None) -> str:
        """HTTP 结果 → 处置（sent / duplicate / rejected / retry）。

        - 2xx：接受。响应 `accepted=false, skipped=true` 视为 **duplicate**（幂等命中）；
        - 2xx 且 `accepted=false, retryable=true`：平台**写入失败**（瞬时）→ 重试；
        - 429：限流，重试（绝不转死信——限流是暂时状态）；
        - 其它 4xx：拒绝（死信）；
        - 5xx / 0（网络错误）：重试。
        """
        if status == 429:
            return "retry"
        if 200 <= status < 300:
            if isinstance(payload, dict) and payload.get("skipped") is True and payload.get("accepted") is False:
                return "duplicate"
            if isinstance(payload, dict) and payload.get("accepted") is False:
                if payload.get("retryable") is True:
                    # 平台写入失败（DB/连接瞬时故障）：可安全重试（平台已释放幂等认领）
                    return "retry"
                # 平台明确拒绝（非法帧/坏时钟/租户上下文缺失）——重试不会变好，转死信。
                return "rejected"
            return "sent"
        if 400 <= status < 500:
            return "rejected"
        return "retry"


__all__ = [
    "BATCH_SIZE",
    "MAX_BACKOFF_SEC",
    "MAX_BUFFER",
    "MAX_RECORD_ID_TRACE",
    "SensorUplinkBridge",
]
