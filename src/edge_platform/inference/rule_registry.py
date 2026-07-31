"""规则注册表：版本化注册、启用/禁用、批量评估。

对应 spec「算法分阶段实施」与「规则配置修改产生新版本，不覆盖旧版本」：
- 每个 rule_id 维护版本历史（按注册顺序追加），新版本注册不覆盖旧版本。
- enable / disable 作用于 (rule_id, rule_version) 维度；新注册版本默认启用。
- Task 21.1：register_config 接受完整 config dict（含 thresholds/duration/
  recovery/cooldown/severity/applicable_firmware/evidence_fields/approver_id/
  effective_from 等），get_config 按版本取回，list_enabled 返回启用规则及
  完整配置。
- evaluate_all(ctx) 运行所有启用规则，返回 RuleFinding 列表（去重/冷却交由
  EventEngine，本注册表保持简单：仅顺序执行所有启用规则）。

纯 Python 标准库实现。
"""

from typing import Any, Dict, List, Optional, Set

from .spatial_rules import RuleBase, RuleFinding

# Task 21.1: config dict 支持的完整字段
_CONFIG_FIELDS = (
    "rule_id", "rule_version", "enabled", "thresholds", "duration_sec",
    "recovery_sec", "cooldown_sec", "severity", "applicable_firmware",
    "evidence_fields", "approver_id", "effective_from",
)


class RuleRegistry:
    """规则注册表（版本化，保留历史）。"""

    def __init__(self):
        # rule_id -> list[rule_instance]（按注册顺序，最新在尾）
        self._versions: Dict[str, List[RuleBase]] = {}
        # rule_id -> set(enabled rule_version)
        self._enabled: Dict[str, Set[str]] = {}
        # Task 21.1: (rule_id, rule_version) -> config dict
        self._configs: dict[str, dict[str, dict[str, Any]]] = {}

    def register(self, rule: RuleBase) -> RuleBase:
        """注册一条规则实例；同一 rule_id 的历史版本保留，新版本默认启用。

        同 (rule_id, rule_version) 重复注册视为幂等替换（覆盖同版本实例）。
        """
        if not isinstance(rule, RuleBase):
            raise TypeError("只接受 RuleBase 实例")
        rid = rule.rule_id
        ver = rule.rule_version
        versions = self._versions.setdefault(rid, [])
        for i, existing in enumerate(versions):
            if existing.rule_version == ver:
                versions[i] = rule  # 同版本幂等替换
                break
        else:
            versions.append(rule)  # 新版本追加，不覆盖旧版本
        self._enabled.setdefault(rid, set()).add(ver)
        return rule

    # ---- Task 21.1: config dict 注册 ----
    def register_config(self, rule_id: str, rule_version: str,
                        config: dict[str, Any]) -> dict[str, Any]:
        """以 config dict 注册一条规则版本（无需 RuleBase 实例）。

        config 支持字段（见 _CONFIG_FIELDS）：
        rule_id / rule_version / enabled / thresholds / duration_sec /
        recovery_sec / cooldown_sec / severity / applicable_firmware /
        evidence_fields / approver_id / effective_from

        同 (rule_id, rule_version) 重复注册视为幂等替换。
        若 config["enabled"] 显式为 False，则注册后处于禁用状态。
        """
        if not rule_id or not rule_version:
            raise ValueError("rule_id 和 rule_version 不能为空")
        enabled = bool(config.get("enabled", True))
        cfg = {k: config.get(k) for k in _CONFIG_FIELDS}
        cfg["rule_id"] = rule_id
        cfg["rule_version"] = rule_version
        cfg["enabled"] = enabled
        self._configs.setdefault(rule_id, {})[rule_version] = cfg
        if enabled:
            self._enabled.setdefault(rule_id, set()).add(rule_version)
        else:
            self._enabled.setdefault(rule_id, set()).discard(rule_version)
        return cfg

    def get_config(self, rule_id: str, rule_version: str) -> Optional[dict[str, Any]]:
        """取回指定 (rule_id, rule_version) 的完整 config dict。

        优先返回 register_config 注册的 config；若仅有 RuleBase 实例，
        则从实例属性派生等价 config。
        """
        cfgs = self._configs.get(rule_id)
        if cfgs and rule_version in cfgs:
            return dict(cfgs[rule_version])
        # 从 RuleBase 实例派生
        for r in self._versions.get(rule_id, []):
            if r.rule_version == rule_version:
                return self._config_from_rule(r)
        return None

    @staticmethod
    def _config_from_rule(rule: RuleBase) -> dict[str, Any]:
        """从 RuleBase 实例属性派生 config dict。"""
        return {
            "rule_id": rule.rule_id,
            "rule_version": rule.rule_version,
            "enabled": True,
            "thresholds": dict(getattr(rule, "config", {}) or {}),
            "duration_sec": None,
            "recovery_sec": None,
            "cooldown_sec": None,
            "severity": rule.severity,
            "applicable_firmware": None,
            "evidence_fields": None,
            "approver_id": None,
            "effective_from": None,
        }

    def list_enabled(self) -> list[dict[str, Any]]:
        """返回所有启用规则的完整 config 列表（按 rule_id 字典序，再按版本序）。

        同时覆盖 register_config 注册的纯配置规则和 register 注册的
        RuleBase 实例规则。
        """
        out = []
        all_rids = sorted(set(self._versions.keys()) | set(self._configs.keys()))
        for rid in all_rids:
            enabled_vers = self._enabled.get(rid, set())
            if not enabled_vers:
                continue
            # 收集该 rule_id 下所有已启用版本
            seen = set()
            for r in self._versions.get(rid, []):
                if r.rule_version in enabled_vers and r.rule_version not in seen:
                    seen.add(r.rule_version)
                    out.append(self._config_from_rule(r))
            for ver, cfg in (self._configs.get(rid, {})).items():
                if ver in enabled_vers and ver not in seen:
                    out.append(dict(cfg))
        return out

    def all(self) -> List[RuleBase]:
        """返回每个 rule_id 的最新版本（按 rule_id 字典序）。"""
        out = []
        for rid in sorted(self._versions.keys()):
            out.append(self._versions[rid][-1])
        return out

    def by_id(self, rule_id: str) -> List[RuleBase]:
        """返回某 rule_id 的全部版本历史（按注册顺序）。"""
        return list(self._versions.get(rule_id, []))

    def enabled(self) -> List[RuleBase]:
        """返回所有启用的规则实例（多版本启用时每个版本都返回，按注册顺序）。"""
        out = []
        for rid, versions in self._versions.items():
            enabled_vers = self._enabled.get(rid, set())
            for r in versions:
                if r.rule_version in enabled_vers:
                    out.append(r)
        return out

    def enable(self, rule_id: str, rule_version: Optional[str] = None) -> bool:
        """启用某 rule_id 的指定版本；未指定 version 则启用最新版本。"""
        # RuleBase 实例
        versions = self._versions.get(rule_id)
        cfgs = self._configs.get(rule_id)
        if not versions and not cfgs:
            return False
        if rule_version is None:
            if versions:
                rule_version = versions[-1].rule_version
            elif cfgs:
                rule_version = sorted(cfgs.keys())[-1]
            else:
                return False
        has_rule = versions and any(r.rule_version == rule_version for r in versions)
        has_cfg = cfgs and rule_version in cfgs
        if not has_rule and not has_cfg:
            return False
        self._enabled.setdefault(rule_id, set()).add(rule_version)
        return True

    def disable(self, rule_id: str, rule_version: Optional[str] = None) -> bool:
        """禁用某 rule_id 的指定版本；未指定 version 则禁用其全部版本。"""
        if rule_id not in self._versions and rule_id not in self._configs:
            return False
        if rule_version is None:
            self._enabled.pop(rule_id, None)
            return True
        s = self._enabled.get(rule_id)
        if s and rule_version in s:
            s.discard(rule_version)
            return True
        return False

    def versions(self, rule_id: str) -> List[str]:
        """返回某 rule_id 的版本字符串历史（按注册顺序）。"""
        out = [r.rule_version for r in self._versions.get(rule_id, [])]
        # 追加 config-only 版本（去重）
        cfgs = self._configs.get(rule_id, {})
        for ver in cfgs:
            if ver not in out:
                out.append(ver)
        return out

    def is_enabled(self, rule_id: str, rule_version: Optional[str] = None) -> bool:
        """判断某 rule_id（可指定版本）是否启用。"""
        if rule_id not in self._versions and rule_id not in self._configs:
            return False
        s = self._enabled.get(rule_id, set())
        if rule_version is None:
            return bool(s)
        return rule_version in s

    def evaluate_all(self, ctx) -> List[RuleFinding]:
        """运行所有启用规则，返回 RuleFinding 列表（按规则注册顺序）。

        去重/冷却交由 EventEngine；本方法仅顺序执行，单条规则异常会冒泡（避免
        静默吞错，便于验收期发现问题）。
        """
        out = []
        for r in self.enabled():
            finding = r.evaluate(ctx)
            if finding is not None:
                out.append(finding)
        return out
