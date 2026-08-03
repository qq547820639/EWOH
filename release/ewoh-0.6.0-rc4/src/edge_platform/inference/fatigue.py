"""负荷与疲劳趋势评分（算法第三阶段）。

对应 spec「算法分阶段实施」第三阶段：负荷与疲劳趋势评分。本模块 ONLY 做趋势评分，
不做医学诊断（spec：「只做趋势评分，不做医学诊断」「不使用「患病」「健康异常」
等表述」）。输出：当前负荷 / 30 分钟趋势 / 主要原因 / 建议。

设计要点：
- 纯 Python 标准库实现。
- 复用 edge_platform.spatial.new_id / now_iso 与 edge_platform.inference.ts_to_ms
  / ms_to_ts，沿用 ISO 8601 时间戳与毫秒整数约定。
- FatigueScorer 维护每人员滚动状态：环形缓冲（默认 1 小时）+ 班次累计负荷积分
  （跨整个班次累加，不被环形缓冲裁剪）+ 个体基线（来自参考班次样本）。
- 所有 main_causes / recommendation 必须引用真实计算值（次数、时长、基线偏差），
  不得虚构。
- is_medical 恒为 False，并由 _assert_non_medical 在 score() 出口处校验，禁止出现
  「患病」「健康异常」「诊断」等医学表述。

LoadSample.action 取值：
  stand / walk / bend / lift / lower / carry / reach / push / pull / kneel / idle / unknown
"""

import enum
from collections import deque
from dataclasses import dataclass

from edge_platform.inference import ts_to_ms
from edge_platform.spatial import new_id, now_iso  # noqa: F401  沿用包内 ID/时间约定

# ---------- 常量 ----------

MODEL_VERSION = "fatigue-trend-v1.0"

# 安全不变量：本模块恒不输出医学诊断，禁止出现以下表述。
FORBIDDEN_MEDICAL_TERMS = ("患病", "健康异常", "诊断", "疾病", "病症", "医学诊断")
IS_MEDICAL = False

# 动作集合
STATIC_POSTURE_ACTIONS = ("bend", "reach", "kneel")  # 静态姿态（持续负荷）
HIGH_RISK_ACTIONS = ("lift", "carry")  # 高风险搬运动作

# 负荷等级阈值（与 LoadLevel 一致）
LOW_THRESHOLD = 0.4
HIGH_THRESHOLD = 0.7

# 趋势斜率阈值（负荷/分钟）
TREND_RISING_THRESHOLD = 0.003
TREND_FALLING_THRESHOLD = -0.003

# 默认配置
DEFAULT_BUFFER_SEC = 3600  # 环形缓冲时长（1 小时）
DEFAULT_SHIFT_TIMEOUT_SEC = 3600  # 班次空闲超时复位（1 小时无样本视为换班）
STATIC_LOAD_SUSTAINED = 0.2  # 静态姿态「在负荷下」的负荷阈值
STATIC_DURATION_THRESHOLD_SEC = 120.0  # 静态姿势告警时长阈值
HIGH_RISK_COUNT_THRESHOLD = 10  # 高风险动作告警次数阈值
ASSIST_LOW_THRESHOLD = 0.2  # 助力收益偏低阈值
EXPECTED_SAMPLES_PER_30MIN = 20  # 期望样本密度（置信度覆盖估算）


# ---------- 数据结构 ----------


class LoadLevel(enum.Enum):
    """负荷等级（仅趋势评分，非医学诊断）。"""

    LOW = "LOW"  # < 0.4
    MEDIUM = "MEDIUM"  # 0.4 ~ 0.7
    HIGH = "HIGH"  # > 0.7

    @classmethod
    def from_score(cls, score: float) -> "LoadLevel":
        if score < LOW_THRESHOLD:
            return cls.LOW
        if score <= HIGH_THRESHOLD:
            return cls.MEDIUM
        return cls.HIGH

    @property
    def zh(self) -> str:
        return {"LOW": "低", "MEDIUM": "中", "HIGH": "高"}[self.value]


class TrendDirection(enum.Enum):
    """30 分钟趋势方向。"""

    RISING = "RISING"
    STABLE = "STABLE"
    FALLING = "FALLING"

    @property
    def zh(self) -> str:
        return {"RISING": "上升", "STABLE": "平稳", "FALLING": "下降"}[self.value]


@dataclass
class LoadSample:
    """单条负荷样本：某动作窗口的瞬时负荷、助力水平与窗口时长。"""

    ts: str  # ISO 8601 时间戳
    action: str  # stand/walk/bend/lift/lower/carry/reach/push/pull/kneel/idle/unknown
    load_level: float  # 0..1 瞬时负荷
    assist_level: float  # 0..1 助力水平（外骨骼助力）
    duration_sec: float  # 该样本代表的窗口秒数


@dataclass
class FatigueReport:
    """负荷与疲劳趋势评分报告（非医学诊断，is_medical 恒为 False）。"""

    person_id: str
    generated_at: str
    current_load_level: str  # LOW/MEDIUM/HIGH
    current_load_score: float  # 0..1
    trend_30min: str  # RISING/STABLE/FALLING
    trend_per_min: float  # 近期负荷斜率（负荷/分钟）
    main_causes: list[str]  # 中文主要原因（引用真实计算值）
    recommendation: str  # 中文建议
    individual_baseline: float  # 个体基线（参考班次累计负荷，load·秒）
    deviation_from_baseline: float  # 当前累计负荷相对基线的偏差（load·秒）
    confidence: float  # 0..1，来自样本覆盖与新鲜度
    model_version: str
    is_medical: bool = False  # 安全不变量：恒为 False


# ---------- 工具函数 ----------


def recovery_minutes(load_score: float, deviation_from_baseline: float = 0.0) -> int:
    """基于负荷评分与基线偏差估算恢复时间（分钟）。

    负荷越高、高于基线越多 → 建议恢复时间越长。仅趋势评分用途，不构成医学建议。
    """
    base = max(0.0, load_score - 0.3) * 30.0  # 0.3 以下 0 分钟；0.7→12；1.0→21
    extra = max(0.0, deviation_from_baseline) * 0.01  # 累计负荷偏差折算分钟
    return int(round(base + extra))


def _clip(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _weighted_recent_load(samples: list[LoadSample], now_ms: int, window_ms: int) -> float:
    """近期瞬时负荷的加权平均（越新权重越高，线性衰减）。"""
    items = []
    for s in samples:
        age = now_ms - ts_to_ms(s.ts)
        if 0 <= age <= window_ms:
            items.append((s, age))
    if not items:
        return 0.0
    weights = [max(0.0, 1.0 - age / window_ms) for _, age in items]
    total = sum(weights)
    if total <= 0:
        # 全部退化到等权
        return sum(s.load_level for s, _ in items) / len(items)
    return sum(w * s.load_level for (s, _), w in zip(items, weights)) / total


def _load_slope_per_min(samples: list[LoadSample], now_ms: int, window_ms: int) -> float:
    """近期负荷相对时间的线性回归斜率（负荷/分钟，正=上升）。"""
    items = [s for s in samples if 0 <= now_ms - ts_to_ms(s.ts) <= window_ms]
    if len(items) < 2:
        return 0.0
    t0 = ts_to_ms(items[0].ts)
    xs = [(ts_to_ms(s.ts) - t0) / 60000.0 for s in items]
    ys = [s.load_level for s in items]
    n = len(xs)
    xbar = sum(xs) / n
    ybar = sum(ys) / n
    num = sum((x - xbar) * (y - ybar) for x, y in zip(xs, ys))
    den = sum((x - xbar) ** 2 for x in xs)
    if den <= 0:
        return 0.0
    return num / den


def _classify_trend(slope: float) -> TrendDirection:
    if slope > TREND_RISING_THRESHOLD:
        return TrendDirection.RISING
    if slope < TREND_FALLING_THRESHOLD:
        return TrendDirection.FALLING
    return TrendDirection.STABLE


def _assert_non_medical(report: FatigueReport) -> None:
    """安全不变量校验：is_medical 必为 False，且不得出现医学表述。"""
    assert report.is_medical is False, "负荷趋势评分不得为医学诊断（is_medical 必为 False）"
    blob = "".join(report.main_causes) + report.recommendation
    for term in FORBIDDEN_MEDICAL_TERMS:
        assert term not in blob, f"负荷趋势评分出现禁止的医学表述：{term!r}"


# ---------- 评分器 ----------


class FatigueScorer:
    """每人员滚动状态的负荷与疲劳趋势评分器。

    维护：
    - samples：环形缓冲（按时间裁剪到 buffer_sec，默认 1 小时），用于短期/趋势计算。
    - shift_cumulative / shift_duration：班次累计负荷积分与累计时长（跨整个班次，
      不被环形缓冲裁剪；长时间空闲超时则复位）。
    - baselines：个体基线（来自 update_baseline 的参考班次样本）。
    """

    def __init__(
        self,
        buffer_sec: int = DEFAULT_BUFFER_SEC,
        shift_timeout_sec: int = DEFAULT_SHIFT_TIMEOUT_SEC,
        model_version: str = MODEL_VERSION,
    ):
        self.buffer_sec = buffer_sec
        self.shift_timeout_sec = shift_timeout_sec
        self.model_version = model_version
        # person_id -> {"samples": deque, "shift_cumulative", "shift_duration", "last_ms"}
        self._state: dict[str, dict] = {}
        # person_id -> 基线字典
        self._baselines: dict[str, dict] = {}

    # ---- 基线 ----

    def update_baseline(self, person_id: str, shift_load_samples: list[LoadSample]) -> float:
        """根据参考班次样本计算个体基线。

        计算：
        - baseline_cumulative：参考班次累计负荷积分（load·秒）= Σ load·duration
        - baseline_duration：参考班次总时长（秒）
        - baseline_load_rate：平均负荷率（0..1）
        - baseline_high_risk_count：参考班次 lift/carry 次数
        - baseline_bend_duration：参考班次弯腰持续时长（秒）

        返回 baseline_cumulative（即 FatigueReport.individual_baseline）。
        """
        if not shift_load_samples:
            self._baselines[person_id] = {
                "baseline_cumulative": 0.0,
                "baseline_duration": 0.0,
                "baseline_load_rate": 0.0,
                "baseline_high_risk_count": 0,
                "baseline_bend_duration": 0.0,
                "has_baseline": False,
            }
            return 0.0
        cumulative = 0.0
        duration = 0.0
        high_risk = 0
        bend_dur = 0.0
        for s in shift_load_samples:
            cumulative += max(0.0, s.load_level) * max(0.0, s.duration_sec)
            duration += max(0.0, s.duration_sec)
            if s.action in HIGH_RISK_ACTIONS:
                high_risk += 1
            if s.action == "bend":
                bend_dur += max(0.0, s.duration_sec)
        rate = cumulative / duration if duration > 0 else 0.0
        self._baselines[person_id] = {
            "baseline_cumulative": cumulative,
            "baseline_duration": duration,
            "baseline_load_rate": rate,
            "baseline_high_risk_count": high_risk,
            "baseline_bend_duration": bend_dur,
            "has_baseline": True,
        }
        return cumulative

    # ---- 摄入 ----

    def ingest(self, person_id: str, sample: LoadSample) -> None:
        """追加一条负荷样本到该人员的环形缓冲，并累加班次累计负荷。"""
        st = self._state.get(person_id)
        ts_ms = ts_to_ms(sample.ts)
        if st is None:
            st = {
                "samples": deque(),
                "shift_cumulative": 0.0,
                "shift_duration": 0.0,
                "last_ms": ts_ms,
            }
            self._state[person_id] = st
        # 长时间空闲 → 视为换班，复位班次累计
        if st["last_ms"] is not None and ts_ms - st["last_ms"] > self.shift_timeout_sec * 1000:
            st["shift_cumulative"] = 0.0
            st["shift_duration"] = 0.0
            st["samples"].clear()
        st["samples"].append(sample)
        st["shift_cumulative"] += max(0.0, sample.load_level) * max(0.0, sample.duration_sec)
        st["shift_duration"] += max(0.0, sample.duration_sec)
        st["last_ms"] = ts_ms
        # 裁剪环形缓冲（按时间）
        cutoff = ts_ms - self.buffer_sec * 1000
        while st["samples"] and ts_to_ms(st["samples"][0].ts) < cutoff:
            st["samples"].popleft()

    # ---- 评分 ----

    def score(self, person_id: str, horizon_min: int = 30) -> FatigueReport:
        """生成本人员当前的负荷与疲劳趋势评分报告。"""
        st = self._state.get(person_id)
        samples: list[LoadSample] = list(st["samples"]) if st else []
        horizon_ms = horizon_min * 60 * 1000
        now_ms = ts_to_ms(samples[-1].ts) if samples else ts_to_ms(now_iso())

        # ---- 各分项指标（全部基于真实样本计算） ----
        # 近期窗口样本（用于短期/静态/高风险/助力等「近期」分项）
        recent = [s for s in samples if 0 <= now_ms - ts_to_ms(s.ts) <= horizon_ms]
        short_term = _weighted_recent_load(samples, now_ms, horizon_ms)

        # 班次累计负荷积分（跨整个班次，不被环形缓冲裁剪）
        shift_cumulative = st["shift_cumulative"] if st else 0.0
        shift_duration = st["shift_duration"] if st else 0.0
        current_avg_load = (shift_cumulative / shift_duration) if shift_duration > 0 else 0.0

        # 静态姿态持续时长（在负荷下，近期窗口）
        bend_dur = 0.0
        reach_kneel_dur = 0.0
        for s in recent:
            if s.action in STATIC_POSTURE_ACTIONS and s.load_level >= STATIC_LOAD_SUSTAINED:
                if s.action == "bend":
                    bend_dur += max(0.0, s.duration_sec)
                else:
                    reach_kneel_dur += max(0.0, s.duration_sec)
        static_duration = bend_dur + reach_kneel_dur

        # 高风险动作累计次数（近期窗口内）
        high_risk_count = sum(1 for s in recent if s.action in HIGH_RISK_ACTIONS)

        # 助力收益估算（assist·秒；越高代表外骨骼越在帮忙，近期窗口）
        assist_benefit = sum(max(0.0, s.assist_level) * max(0.0, s.duration_sec) for s in recent)
        recent_duration = sum(max(0.0, s.duration_sec) for s in recent)
        assist_rate = (assist_benefit / recent_duration) if recent_duration > 0 else 0.0

        # 个体基线偏差（当前累计 vs 基线按当前时长折算的期望累计）
        bl = self._baselines.get(person_id, {})
        has_baseline = bl.get("has_baseline", False)
        baseline_cumulative = bl.get("baseline_cumulative", 0.0)
        baseline_duration = bl.get("baseline_duration", 0.0)
        baseline_high_risk = bl.get("baseline_high_risk_count", 0)
        baseline_bend = bl.get("baseline_bend_duration", 0.0)
        if has_baseline and baseline_duration > 0:
            expected_cumulative = baseline_cumulative * (shift_duration / baseline_duration)
        else:
            expected_cumulative = 0.0
        deviation = shift_cumulative - expected_cumulative if has_baseline else 0.0

        # ---- 综合评分（0..1） ----
        # 分项均归一化到 0..1，助力收益为负向（外骨骼帮忙则降低疲劳评分）。
        short_term_c = _clip(short_term, 0.0, 1.0)
        cumulative_c = _clip(current_avg_load, 0.0, 1.0)
        static_c = _clip(static_duration / STATIC_DURATION_THRESHOLD_SEC, 0.0, 1.0)
        high_risk_c = _clip(high_risk_count / HIGH_RISK_COUNT_THRESHOLD, 0.0, 1.0)
        assist_c = _clip(assist_rate, 0.0, 1.0)
        score = 0.40 * short_term_c + 0.20 * cumulative_c + 0.20 * static_c + 0.15 * high_risk_c - 0.10 * assist_c
        score = _clip(score, 0.0, 1.0)

        level = LoadLevel.from_score(score)
        slope = _load_slope_per_min(samples, now_ms, horizon_ms)
        trend = _classify_trend(slope)

        # ---- 主要原因（引用真实计算值） ----
        causes: list[str] = []
        if bend_dur > max(baseline_bend, STATIC_DURATION_THRESHOLD_SEC):
            causes.append(f"连续弯腰时间增加（{bend_dur:.0f} 秒）")
        if reach_kneel_dur > STATIC_DURATION_THRESHOLD_SEC:
            causes.append(f"探取/跪姿静态姿势持续（{reach_kneel_dur:.0f} 秒）")
        if has_baseline:
            if high_risk_count > baseline_high_risk:
                causes.append(f"搬运次数 {int(high_risk_count)} 高于个人基线 {int(baseline_high_risk)}")
        else:
            if high_risk_count > HIGH_RISK_COUNT_THRESHOLD:
                causes.append(f"近 {int(horizon_min)} 分钟搬运 {int(high_risk_count)} 次")
        if has_baseline and deviation > 0:
            causes.append(f"累计负荷高于个人基线（偏差 {deviation:.1f}）")
        if assist_rate < ASSIST_LOW_THRESHOLD and score > LOW_THRESHOLD:
            causes.append(f"外骨骼助力不足（助力收益 {assist_rate:.2f}）")

        # ---- 建议（依据真实分项条件给出） ----
        rec_min = recovery_minutes(score, deviation)
        if not samples:
            recommendation = "负荷数据不足，暂无建议"
        elif level is LoadLevel.HIGH:
            recommendation = f"当前任务结束后安排低负荷工位或短时恢复（建议恢复 {int(rec_min)} 分钟）"
        elif level is LoadLevel.MEDIUM:
            if trend is TrendDirection.RISING:
                recommendation = f"负荷上升，建议适时安排短时恢复（建议恢复 {int(rec_min)} 分钟）"
            else:
                recommendation = "负荷中等，保持关注，必要时短时恢复"
        else:
            recommendation = "负荷正常，保持当前节奏"

        # ---- 置信度（样本覆盖 × 新鲜度） ----
        recent_count = sum(1 for s in samples if 0 <= now_ms - ts_to_ms(s.ts) <= horizon_ms)
        coverage = _clip(recent_count / EXPECTED_SAMPLES_PER_30MIN, 0.0, 1.0)
        if samples:
            latest_age_sec = (now_ms - ts_to_ms(samples[-1].ts)) / 1000.0
            recency = _clip(1.0 - latest_age_sec / 300.0, 0.0, 1.0)
        else:
            recency = 0.0
        confidence = _clip(coverage * recency, 0.0, 1.0)

        report = FatigueReport(
            person_id=person_id,
            generated_at=now_iso(),
            current_load_level=level.value,
            current_load_score=round(score, 4),
            trend_30min=trend.value,
            trend_per_min=round(slope, 6),
            main_causes=causes,
            recommendation=recommendation,
            individual_baseline=round(baseline_cumulative, 4),
            deviation_from_baseline=round(deviation, 4),
            confidence=round(confidence, 4),
            model_version=self.model_version,
            is_medical=False,
        )
        # 安全不变量：本评分恒不为医学诊断
        _assert_non_medical(report)
        return report


# ---------- 输出格式化 ----------


def format_report(report: FatigueReport) -> str:
    """将报告格式化为 4 行中文文本块（对齐 spec 示例）。

    示例：
        当前负荷：中
        30分钟趋势：上升
        主要原因：连续弯腰时间增加、搬运次数高于个人基线
        建议：当前任务结束后安排低负荷工位或短时恢复
    """
    level_zh = {"LOW": "低", "MEDIUM": "中", "HIGH": "高"}.get(report.current_load_level, report.current_load_level)
    trend_zh = {"RISING": "上升", "STABLE": "平稳", "FALLING": "下降"}.get(report.trend_30min, report.trend_30min)
    causes_text = "、".join(report.main_causes) if report.main_causes else "无明显异常因素"
    lines = [
        f"当前负荷：{level_zh}",
        f"30分钟趋势：{trend_zh}",
        f"主要原因：{causes_text}",
        f"建议：{report.recommendation}",
    ]
    return "\n".join(lines)
