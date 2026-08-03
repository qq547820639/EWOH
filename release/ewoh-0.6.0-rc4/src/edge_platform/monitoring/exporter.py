"""Task 33 Prometheus 文本格式导出器（PrometheusExporter）。

将 MetricsCollector.snapshot() 输出的 dict 转为标准 Prometheus exposition format：
    # HELP <metric> <help>
    # TYPE <metric> <gauge|counter>
    <metric>{<labels>} <value>

不引入 prometheus_client 库，手写文本格式。仅使用 Python 标准库。
"""

# 指标定义：(prom_name, type, help, source_key, labels_spec)
# - source_key: snapshot() 返回 dict 中的键
# - labels_spec: None 表示标量；tuple 表示从 dict 派生出的 (label_name, value) 对，
#   这里仅用于 db_counts 这种 dict 类型，固定使用 table 标签
_METRIC_DEFS = [
    # 系统级
    ("ewoh_uptime_seconds", "gauge", "Platform uptime since collector start in seconds.", "uptime_seconds", None),
    ("ewoh_db_count", "gauge", "Database row counts grouped by table.", "db_counts", ("table",)),
    # 设备级
    ("ewoh_device_online_count", "gauge", "Number of currently online devices.", "online_count", None),
    ("ewoh_device_offline_count", "gauge", "Number of currently offline devices.", "offline_count", None),
    (
        "ewoh_device_avg_packet_loss_pct",
        "gauge",
        "Average packet loss percentage across devices.",
        "avg_packet_loss_pct",
        None,
    ),
    ("ewoh_device_low_battery_count", "gauge", "Number of devices with low battery.", "low_battery_count", None),
    # 推理级
    (
        "ewoh_inference_count_total",
        "counter",
        "Total number of inferences recorded since collector start.",
        "inference_count",
        None,
    ),
    ("ewoh_inference_p50_ms", "gauge", "P50 inference latency in milliseconds.", "inference_p50_ms", None),
    ("ewoh_inference_p95_ms", "gauge", "P95 inference latency in milliseconds.", "inference_p95_ms", None),
    (
        "ewoh_inference_unknown_count_total",
        "counter",
        "Total number of inferences labeled unknown.",
        "unknown_count",
        None,
    ),
    (
        "ewoh_inference_error_count_total",
        "counter",
        "Total number of inferences that raised an error.",
        "error_count",
        None,
    ),
    # 业务级
    ("ewoh_event_open_count", "gauge", "Number of currently open risk events.", "open_event_count", None),
    (
        "ewoh_event_open_total",
        "counter",
        "Cumulative number of events opened since collector start.",
        "event_open_total",
        None,
    ),
    ("ewoh_event_avg_close_hours", "gauge", "Average hours to close an event.", "avg_event_close_hours", None),
    (
        "ewoh_assignment_recommendation_count_total",
        "counter",
        "Total number of task recommendations generated.",
        "recommendation_count",
        None,
    ),
    (
        "ewoh_assignment_confirmed_count_total",
        "counter",
        "Total number of task assignments confirmed by humans.",
        "confirmed_count",
        None,
    ),
    (
        "ewoh_assignment_adoption_rate",
        "gauge",
        "Fraction of recommendations confirmed (confirmed/recommended).",
        "assignment_adoption_rate",
        None,
    ),
]


def _format_value(v):
    """格式化数值；dict/None → 0；float 保留原生表达；bool → 1/0。"""
    if v is None:
        return "0"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        if isinstance(v, float) and (v != v):  # NaN
            return "0"
        return repr(v) if isinstance(v, float) else str(v)
    # 字符串/其它类型回落到 0，避免破坏 exposition 格式
    try:
        return str(float(v))
    except (TypeError, ValueError):
        return "0"


def _format_label_value(v):
    """转义 label value 中的反斜杠/双引号/换行（Prometheus 规范）。"""
    return str(v).replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


class PrometheusExporter:
    """将 MetricsCollector.snapshot() 转为 Prometheus exposition format。

    用法：
        exporter = PrometheusExporter()
        text = exporter.format_prometheus(collector.snapshot())
    """

    def __init__(self, collector=None):
        self._collector = collector

    def format_prometheus(self, metrics):
        """将 snapshot dict 转为 Prometheus 文本格式字符串。"""
        if not isinstance(metrics, dict):
            raise TypeError("metrics 必须是 dict（来自 MetricsCollector.snapshot()）")

        lines = []
        for prom_name, mtype, help_text, source_key, labels_spec in _METRIC_DEFS:
            lines.append(f"# HELP {prom_name} {help_text}")
            lines.append(f"# TYPE {prom_name} {mtype}")
            value = metrics.get(source_key)
            if labels_spec is None:
                lines.append(f"{prom_name} {_format_value(value)}")
            elif isinstance(value, dict):
                if not value:
                    # 无数据时输出一条空标签占位，便于抓取端识别序列
                    lines.append(f"{prom_name} 0")
                else:
                    # 按 key 排序保证输出稳定
                    for label_value, v in sorted(value.items()):
                        label_name = labels_spec[0]
                        lines.append(
                            f'{prom_name}{{{label_name}="{_format_label_value(label_value)}"}} {_format_value(v)}'
                        )
            else:
                # 期望 dict 但拿到标量：回落为单值
                lines.append(f"{prom_name} {_format_value(value)}")
        return "\n".join(lines) + "\n"

    # 便捷方法：直接从绑定 collector 生成文本
    def render(self):
        if self._collector is None:
            raise RuntimeError("PrometheusExporter 未绑定 MetricsCollector")
        return self.format_prometheus(self._collector.snapshot())
