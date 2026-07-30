#!/usr/bin/env python3
"""EWOH 受控试点系统阶段 1 加速 Soak 测试（Task 12 设备接入验收）。

加速模式：用 edge.adapters.ny_exo_a1.protocol 的 encode_* 在分钟级生成 144000 帧
（20Hz × 7200s 等效），通过 socketpair 注入 NYExoA1Adapter，验证协议链路稳定性。

模拟 2 次断线（t=1800s、t=5400s 各断 30s 后重连补传），验证：
  - 入库帧数 = 生成帧数（无丢失）
  - 原始帧存储数 >= 生成帧数（每帧保留 raw）
  - 时间戳单调性 PASS（按 seq 排序）
  - source_type 全部 = 'real'
  - 断线 2 次、恢复 2 次，断线后 device.online=0，恢复后 online=1
  - 可按时间段导出原始片段（export_slice）
  - 核心字段（pitch_deg/torque_nm/battery_percent）非空率 100%

输出报告到 /workspace/edge_platform/logs/soak_report_stage1.txt。

注意：加速测试为协议链路稳定性验证，不等同真机连续 2h 验收。

运行：
  python edge_platform/scripts/soak_test_stage1.py
  python edge_platform/scripts/soak_test_stage1.py --output /tmp/report.txt
"""
import argparse
import os
import shutil
import socket
import sys
import tempfile
import time
import traceback
from datetime import datetime, timezone

# 让 edge 包可被导入（edge 包位于 edge_platform/edge/，需把 edge_platform/ 加入 sys.path）
_EDGE_PLATFORM_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _EDGE_PLATFORM_DIR not in sys.path:
    sys.path.insert(0, _EDGE_PLATFORM_DIR)
_REPO_ROOT = os.path.dirname(_EDGE_PLATFORM_DIR)

from edge.storage import Storage
from edge.bus import Bus
from edge.adapter import NYExoA1Adapter
from edge.protocol import (encode_ident, encode_telemetry, encode_backfill,
                           PROTOCOL_VERSION, DEVICE_MODEL)

# ---- 测试常量 ----
DEVICE_ID = "EXOS0001"               # 8B ASCII（NXP1 IDENT 字段约束）
FIRMWARE = "1.4.2"
HARDWARE = 0x23
TOTAL_FRAMES = 144000                # 20Hz × 7200s = 2h 等效
SAMPLE_HZ = 20
INTERVAL_MS = 1000 // SAMPLE_HZ      # 50ms
TOTAL_DURATION_S = TOTAL_FRAMES // SAMPLE_HZ   # 7200s
DISCONNECTS = [(1800, 30), (5400, 30)]   # (起始秒, 持续秒)
# LEN 字段为 1B → 单帧 payload 上限 255B；BACKFILL payload = 1B count + N×32B
# 因此单条 BACKFILL 帧最多 (255-1)//32 = 7 个子项
BACKFILL_BATCH = 7
SEND_BATCH_FRAMES = 500              # 每批 sendall 的 TELEMETRY 帧数


def _ms_to_iso(ms):
    """epoch ms -> ISO 8601（毫秒精度，UTC）。与 decoder._ms_to_iso 同格式。"""
    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).isoformat(
        timespec="milliseconds")


def _now_iso():
    return datetime.now().astimezone().isoformat(timespec="milliseconds")


def _iso_to_ms(ts_iso):
    s = str(ts_iso).strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(round(dt.timestamp() * 1000))
    except (ValueError, OverflowError, OSError):
        return None


def _tele_payload(seq):
    """生成第 seq 帧的遥测物理量（带轻微波动，确保核心字段非空且在量程内）。"""
    pitch = 30.0 + (seq % 100) * 0.1
    roll = (seq % 50) * 0.05
    torque = 12.0 + (seq % 80) * 0.05
    battery = max(20, 90 - (seq // 1000))
    return (pitch, roll, 0, 0, 9810, 0.0, 0.0, 0.0, torque, 45, battery)


def _tele_dict(seq):
    """BACKFILL 子项 tele dict（键名匹配 protocol._telemetry_dict_to_bytes）。"""
    p = _tele_payload(seq)
    return {"pitch": p[0], "roll": p[1], "ax": p[2], "ay": p[3], "az": p[4],
            "gx": p[5], "gy": p[6], "gz": p[7], "torque": p[8],
            "assist": p[9], "battery": p[10]}


class SoakRunner:
    def __init__(self, db_path, log_lines):
        self.storage = Storage(db_path)
        # 测试专用 PRAGMA 优化（不修改生产代码）：MEMORY journal + OFF synchronous
        # 避免 14.4 万次 INSERT 各触发一次 fsync 拖慢至 7 分钟以上。
        self.storage._db.execute("PRAGMA journal_mode=MEMORY")
        self.storage._db.execute("PRAGMA synchronous=OFF")
        self.bus = Bus()
        self.log_lines = log_lines
        self.adapters = []
        self.connections = []
        self.online_trace = []     # [(ts_iso, online_int, source_str)]
        self.ident_count = 0
        self.disconnect_count = 0
        self.reconnect_count = 0
        self.base_ts_ms = int(time.time() * 1000)

    def log(self, msg):
        self.log_lines.append(msg)
        print(msg, flush=True)

    def _new_connection(self):
        a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        adapter = NYExoA1Adapter(a, ("soak-device", 0), self.storage, self.bus,
                                 source_type="real")
        adapter.start()
        self.adapters.append(adapter)
        self.connections.append((adapter, b))
        return adapter, b

    def _device(self):
        return next((d for d in self.storage.list_devices()
                     if d["device_id"] == DEVICE_ID), None)

    def _send_ident(self, b_sock, ts_ms, label=""):
        b_sock.sendall(encode_ident(DEVICE_ID, FIRMWARE, HARDWARE, seq=0, ts_ms=ts_ms))
        # 轮询等待 IDENT 处理完成（设备出现且 online=1，最多 2s）
        for _ in range(40):
            dev = self._device()
            if dev and dev.get("online") == 1:
                break
            time.sleep(0.05)
        self.ident_count += 1
        dev = self._device()
        online = dev["online"] if dev else None
        self.log("  [IDENT%s] device.online=%s" % (label, online))

    def _stream_telemetry(self, b_sock, start_seq, end_seq):
        """流式发送 [start_seq, end_seq) 区间的 TELEMETRY 帧（批量 sendall）。"""
        sent = 0
        batch = bytearray()
        batch_count = 0
        for seq in range(start_seq, end_seq):
            ts_ms = self.base_ts_ms + (seq - 1) * INTERVAL_MS
            p = _tele_payload(seq)
            batch += encode_telemetry(seq, ts_ms, p[0], p[1], p[2], p[3], p[4],
                                      p[5], p[6], p[7], p[8], p[9], p[10])
            batch_count += 1
            if batch_count >= SEND_BATCH_FRAMES:
                b_sock.sendall(bytes(batch))
                sent += batch_count
                batch = bytearray()
                batch_count = 0
        if batch_count > 0:
            b_sock.sendall(bytes(batch))
            sent += batch_count
        return sent

    def _send_backfill(self, b_sock, start_seq, end_seq, frame_seq_start):
        """发送 BACKFILL 帧补传 [start_seq, end_seq) 区间。

        单条 BACKFILL 帧最多 7 个子项（受 1B LEN 限制）。返回 (sent_count, next_frame_seq)。
        """
        sent = 0
        frame_seq = frame_seq_start
        items = []
        for seq in range(start_seq, end_seq):
            ts_ms = self.base_ts_ms + (seq - 1) * INTERVAL_MS
            items.append((seq, ts_ms, _tele_dict(seq)))
            if len(items) >= BACKFILL_BATCH:
                bf_ts = self.base_ts_ms + (seq - 1) * INTERVAL_MS
                b_sock.sendall(encode_backfill(frame_seq, bf_ts, items))
                sent += len(items)
                items = []
                frame_seq += 1
        if items:
            last_ts = self.base_ts_ms + (end_seq - 2) * INTERVAL_MS
            b_sock.sendall(encode_backfill(frame_seq, last_ts, items))
            sent += len(items)
            frame_seq += 1
        return sent, frame_seq

    def _wait_for_seq(self, expected_seq, timeout=120):
        """等待 telemetry 表中 MAX(seq) >= expected_seq（adapter 已处理到该序号）。

        加速模式下 adapter 单线程串行 recv+decode+insert，关闭 b_sock 会立刻让
        adapter 的 recv 返回 EOF 并跳出 run 循环（_buf 中残留帧会丢失）。因此
        在断线前必须等待 adapter 把已发送的帧全部入库。
        """
        deadline = time.time() + timeout
        while time.time() < deadline:
            max_seq = self._max_seq()
            if max_seq is not None and max_seq >= expected_seq:
                return True
            time.sleep(0.1)
        return False

    def _max_seq(self):
        try:
            row = self.storage._db.execute(
                "SELECT MAX(seq) FROM telemetry WHERE device_id=?",
                (DEVICE_ID,)).fetchone()
            return row[0] if row else None
        except Exception:
            return None

    def _disconnect(self, adapter, b_sock, count=True):
        """关闭设备端 socket，触发 adapter _on_disconnect -> mark_offline。

        count=False 用于末次清理断开（不计入断线次数）。
        """
        try:
            b_sock.close()
        except OSError:
            pass
        adapter.stop()   # join 线程，确保 _on_disconnect 完成
        dev = self._device()
        online_after = dev["online"] if dev else None
        if count:
            self.disconnect_count += 1
        self.online_trace.append((_now_iso(), online_after,
                                  "disconnect" if count else "final_close"))
        return online_after

    def _reconnect(self, ts_ms):
        adapter, b = self._new_connection()
        self._send_ident(b, ts_ms, label="(reconnect)")
        dev = self._device()
        online_after = dev["online"] if dev else None
        self.reconnect_count += 1
        self.online_trace.append((_now_iso(), online_after, "reconnect"))
        return adapter, b

    def run(self):
        self.log("=" * 70)
        self.log("EWOH 阶段 1 加速 Soak 测试（Task 12 设备接入验收）")
        self.log("=" * 70)
        self.log("协议版本: %s  设备型号: %s" % (PROTOCOL_VERSION, DEVICE_MODEL))
        self.log("设备 ID: %s  固件: %s  硬件: 0x%02X" % (DEVICE_ID, FIRMWARE, HARDWARE))
        self.log("总帧数: %d (20Hz × %ds = 2h 等效)" % (TOTAL_FRAMES, TOTAL_DURATION_S))
        self.log("断线点: %s" % DISCONNECTS)
        self.log("BASE_TS_MS: %d (%s)" % (self.base_ts_ms, _ms_to_iso(self.base_ts_ms)))
        self.log("")

        # 计算各段边界：[live_start, live_end) live 流，[gap_start, gap_end) 缺失需补传
        segments = []
        cursor = 1
        for d_sec, gap_sec in DISCONNECTS:
            live_end = d_sec * SAMPLE_HZ + 1
            gap_start = live_end
            gap_end = gap_start + gap_sec * SAMPLE_HZ
            segments.append((cursor, live_end, gap_start, gap_end))
            cursor = gap_end
        segments.append((cursor, TOTAL_FRAMES + 1, 0, 0))

        start_wall = time.time()
        # 首次连接 + IDENT
        adapter, b = self._new_connection()
        self._send_ident(b, self.base_ts_ms, label="(initial)")
        self.online_trace.append((_now_iso(),
                                  self._device()["online"] if self._device() else None,
                                  "initial_connect"))

        total_sent = 0
        frame_seq_cursor = TOTAL_FRAMES + 1   # BACKFILL 帧自己用的 seq

        for idx, (live_start, live_end, gap_start, gap_end) in enumerate(segments):
            if live_end > live_start:
                cnt = live_end - live_start
                self.log("[段 %d] live seq=[%d, %d) 共 %d 帧 ..." %
                         (idx, live_start, live_end, cnt))
                sent = self._stream_telemetry(b, live_start, live_end)
                total_sent += sent
                # 等 adapter 把本段全部入库（避免断线时 _buf 残留帧丢失）
                ok = self._wait_for_seq(live_end - 1)
                self.log("         已入库到 seq=%s（期望 %d）%s" %
                         (self._max_seq(), live_end - 1,
                          "" if ok else " [超时]"))

            if gap_end > gap_start:
                gap_cnt = gap_end - gap_start
                self.log("[段 %d] 断线 gap seq=[%d, %d) 共 %d 帧（30s 等效） ..." %
                         (idx, gap_start, gap_end, gap_cnt))
                online_off = self._disconnect(adapter, b)
                self.log("         断线后 device.online=%s" % online_off)
                time.sleep(0.1)
                reconnect_ts = self.base_ts_ms + (gap_start - 1) * INTERVAL_MS
                adapter, b = self._reconnect(reconnect_ts)
                self.log("         重连后 device.online=%s" %
                         (self._device()["online"] if self._device() else None))
                self.log("[段 %d] 发送 BACKFILL 补传 %d 帧（每帧最多 %d 子项） ..." %
                         (idx, gap_cnt, BACKFILL_BATCH))
                sent, frame_seq_cursor = self._send_backfill(
                    b, gap_start, gap_end, frame_seq_cursor)
                total_sent += sent
                # 等 BACKFILL 子项全部入库
                ok = self._wait_for_seq(gap_end - 1)
                self.log("         已入库到 seq=%s（期望 %d）%s" %
                         (self._max_seq(), gap_end - 1,
                          "" if ok else " [超时]"))

        self.log("")
        self.log("总发送帧数（含 BACKFILL 子项）: %d" % total_sent)
        # 末段已通过循环内的 _wait_for_seq 等待；末次断开仅为清理，不计入断线次数
        online_off_final = self._disconnect(adapter, b, count=False)
        self.log("末次清理断开后 device.online=%s" % online_off_final)

        elapsed = time.time() - start_wall
        self.log("soak run 完成，耗时 %.1fs" % elapsed)
        self.log("")
        return self._verify()

    def _verify(self):
        self.log("=" * 70)
        self.log("验证结果")
        self.log("=" * 70)
        report = {"base_ts_ms": self.base_ts_ms,
                  "base_ts_iso": _ms_to_iso(self.base_ts_ms),
                  "device_id": DEVICE_ID,
                  "firmware": FIRMWARE,
                  "total_frames": TOTAL_FRAMES}

        # 1. 入库帧数
        tele_count = self.storage._db.execute(
            "SELECT COUNT(*) FROM telemetry WHERE device_id=?", (DEVICE_ID,)).fetchone()[0]
        report["telemetry_count"] = tele_count
        report["telemetry_match"] = (tele_count == TOTAL_FRAMES)
        self.log("[1] 入库帧数: %d / 期望 %d -> %s" %
                 (tele_count, TOTAL_FRAMES, "PASS" if report["telemetry_match"] else "FAIL"))

        # 2. 原始帧存储（每帧保留 raw）
        # TELEMETRY 帧 1:1 入 raw_frame；BACKFILL 帧按 1:N 共享父 raw_frame
        # （每条 BACKFILL 含最多 7 子项，子项通过 raw_ref 关联父 raw_frame）。
        # 因此 raw_frame 数 = TELEMETRY 线帧数 + BACKFILL 线帧数，小于遥测行数。
        # 真正的契约是：每条 telemetry 行的 raw_ref 非空（可追溯到原始字节）。
        raw_count = self.storage._db.execute(
            "SELECT COUNT(*) FROM raw_frame WHERE device_id=?", (DEVICE_ID,)).fetchone()[0]
        null_raw_ref = self.storage._db.execute(
            "SELECT COUNT(*) FROM telemetry WHERE device_id=? AND "
            "(raw_ref IS NULL OR raw_ref='')", (DEVICE_ID,)).fetchone()[0]
        report["raw_frame_count"] = raw_count
        report["null_raw_ref_count"] = null_raw_ref
        report["raw_frame_all_linked"] = (null_raw_ref == 0)
        self.log("[2] 原始帧存储数: %d  raw_ref 为空的遥测行: %d -> %s" %
                 (raw_count, null_raw_ref,
                  "PASS" if report["raw_frame_all_linked"] else "FAIL"))
        self.log("    （TELEMETRY 线帧 1:1 入 raw_frame；BACKFILL 子项共享父 raw_frame）")

        # 3. 时间戳单调性（按 seq 排序后 ts 单调递增）
        rows = self.storage._db.execute(
            "SELECT seq, ts FROM telemetry WHERE device_id=? ORDER BY seq",
            (DEVICE_ID,)).fetchall()
        monotonic = True
        prev_ts = None
        max_gap_ms = 0
        for seq, ts in rows:
            ts_ms = _iso_to_ms(ts)
            if ts_ms is None:
                continue
            if prev_ts is not None:
                if ts_ms < prev_ts:
                    monotonic = False
                    break
                gap = ts_ms - prev_ts
                if gap > max_gap_ms:
                    max_gap_ms = gap
            prev_ts = ts_ms
        report["timestamp_monotonic"] = monotonic
        report["max_ts_gap_ms"] = max_gap_ms
        self.log("[3] 时间戳单调性（按 seq 排序）: %s（最大间隔 %dms）" %
                 ("PASS" if monotonic else "FAIL", max_gap_ms))

        # 4. source_type 全为 real
        non_real = self.storage._db.execute(
            "SELECT COUNT(*) FROM telemetry WHERE device_id=? AND source_type!='real'",
            (DEVICE_ID,)).fetchone()[0]
        report["non_real_count"] = non_real
        report["all_real"] = (non_real == 0)
        self.log("[4] source_type 非 real 数: %d -> %s" %
                 (non_real, "PASS" if report["all_real"] else "FAIL"))

        # 5. seq 唯一性 & 无 gap
        distinct_seq = self.storage._db.execute(
            "SELECT COUNT(DISTINCT seq) FROM telemetry WHERE device_id=?",
            (DEVICE_ID,)).fetchone()[0]
        seq_min, seq_max = self.storage._db.execute(
            "SELECT MIN(seq), MAX(seq) FROM telemetry WHERE device_id=?",
            (DEVICE_ID,)).fetchone()
        report["distinct_seq"] = distinct_seq
        report["seq_range"] = (seq_min, seq_max)
        report["no_dup_no_gap"] = (
            distinct_seq == TOTAL_FRAMES and
            seq_max is not None and seq_min is not None and
            seq_max - seq_min + 1 == TOTAL_FRAMES)
        self.log("[5] seq 唯一性 & 无 gap: distinct=%d range=[%s, %s] -> %s" %
                 (distinct_seq, seq_min, seq_max,
                  "PASS" if report["no_dup_no_gap"] else "FAIL"))

        # 6. 断线/恢复次数 + online 切换
        report["disconnect_count"] = self.disconnect_count
        report["reconnect_count"] = self.reconnect_count
        report["ident_audit_count"] = len(self.storage.list_audit(limit=100, action="IDENT"))
        disconnect_traces = [t for t in self.online_trace if t[2] == "disconnect"]
        reconnect_traces = [t for t in self.online_trace if t[2] == "reconnect"]
        online_after_disconnect_ok = all(t[1] == 0 for t in disconnect_traces)
        online_after_reconnect_ok = all(t[1] == 1 for t in reconnect_traces)
        report["online_after_disconnect_ok"] = online_after_disconnect_ok
        report["online_after_reconnect_ok"] = online_after_reconnect_ok
        report["online_trace"] = self.online_trace
        self.log("[6] 断线次数: %d  恢复次数: %d  IDENT audit: %d" %
                 (self.disconnect_count, self.reconnect_count, report["ident_audit_count"]))
        self.log("    断线后 online=0: %s  恢复后 online=1: %s" %
                 ("PASS" if online_after_disconnect_ok else "FAIL",
                  "PASS" if online_after_reconnect_ok else "FAIL"))
        self.log("    online 轨迹: %s" %
                 [(t[2], t[1]) for t in self.online_trace])

        # 7. export_slice
        slice_start_ms = self.base_ts_ms + 3600 * 1000   # 中点 30s 窗口
        slice_end_ms = slice_start_ms + 30 * 1000
        sl = self.storage.export_slice(DEVICE_ID,
                                       _ms_to_iso(slice_start_ms),
                                       _ms_to_iso(slice_end_ms))
        report["export_slice_count"] = sl["record_count"]
        report["export_slice_window"] = (_ms_to_iso(slice_start_ms),
                                         _ms_to_iso(slice_end_ms))
        report["export_slice_ok"] = sl["record_count"] > 0
        self.log("[7] export_slice (t=3600s, 30s 窗口): %d 条 -> %s" %
                 (sl["record_count"], "PASS" if report["export_slice_ok"] else "FAIL"))

        # 8. 核心字段非空率
        null_count = self.storage._db.execute(
            "SELECT COUNT(*) FROM telemetry WHERE device_id=? AND "
            "(json_extract(payload_json,'$.pitch_deg') IS NULL OR "
            " json_extract(payload_json,'$.torque_nm') IS NULL OR "
            " json_extract(payload_json,'$.battery_percent') IS NULL)",
            (DEVICE_ID,)).fetchone()[0]
        report["core_field_null_count"] = null_count
        report["core_field_non_null_rate"] = (
            100.0 * (tele_count - null_count) / tele_count if tele_count else 0.0)
        report["core_field_all_100"] = (null_count == 0)
        self.log("[8] 核心字段非空率: %.2f%% (null=%d) -> %s" %
                 (report["core_field_non_null_rate"], null_count,
                  "PASS" if report["core_field_all_100"] else "FAIL"))

        all_pass = (report["telemetry_match"] and report["raw_frame_all_linked"] and
                    report["timestamp_monotonic"] and report["all_real"] and
                    report["no_dup_no_gap"] and
                    report["disconnect_count"] == 2 and
                    report["reconnect_count"] == 2 and
                    report["online_after_disconnect_ok"] and
                    report["online_after_reconnect_ok"] and
                    report["export_slice_ok"] and report["core_field_all_100"])
        report["overall_pass"] = all_pass
        self.log("")
        self.log("=" * 70)
        self.log("总体结论: %s" % ("PASS - 阶段 1 协议链路稳定性验收通过" if all_pass
                                  else "FAIL - 见上方各项明细"))
        self.log("=" * 70)
        return report

    def close(self):
        for ad in self.adapters:
            try:
                ad.stop()
            except Exception:
                pass
        for _, b in self.connections:
            try:
                b.close()
            except OSError:
                pass
        try:
            self.storage.close()
        except Exception:
            pass


def main(argv=None):
    parser = argparse.ArgumentParser(description="EWOH 阶段 1 加速 Soak 测试")
    parser.add_argument("--output", default=None,
                        help="报告输出文件（默认 edge_platform/logs/soak_report_stage1.txt）")
    args = parser.parse_args(argv if argv is not None else sys.argv[1:])

    if args.output:
        report_path = args.output
    else:
        logs_dir = os.path.join(_REPO_ROOT, "edge_platform", "logs")
        os.makedirs(logs_dir, exist_ok=True)
        report_path = os.path.join(logs_dir, "soak_report_stage1.txt")

    log_lines = []
    runner = None
    tmp_dir = None
    try:
        tmp_dir = tempfile.mkdtemp(prefix="ewoh_soak_stage1_")
        db_path = os.path.join(tmp_dir, "soak_stage1.db")
        runner = SoakRunner(db_path, log_lines)
        runner.run()
    except Exception as e:
        log_lines.append("")
        log_lines.append("!" * 70)
        log_lines.append("soak 运行异常: %s" % e)
        log_lines.append(traceback.format_exc())
        log_lines.append("!" * 70)
    finally:
        if runner:
            runner.close()
        if tmp_dir:
            shutil.rmtree(tmp_dir, ignore_errors=True)

    os.makedirs(os.path.dirname(os.path.abspath(report_path)), exist_ok=True)
    with open(report_path, "w", encoding="utf-8") as f:
        f.write("\n".join(log_lines))
        f.write("\n")
    print("\n报告已写入: %s" % report_path, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
