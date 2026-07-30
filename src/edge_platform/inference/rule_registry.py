"""规则注册表：版本化注册、启用/禁用、批量评估。

对应 spec「算法分阶段实施」与「规则配置修改产生新版本，不覆盖旧版本」：
- 每个 rule_id 维护版本历史（按注册顺序追加），新版本注册不覆盖旧版本。
- enable / disable 作用于 (rule_id, rule_version) 维度；新注册版本默认启用。
- evaluate_all(ctx) 运行所有启用规则，返回 RuleFinding 列表（去重/冷却交由
  EventEngine，本注册表保持简单：仅顺序执行所有启用规则）。

纯 Python 标准库实现。
"""

from typing import Dict, List, Optional, Set

from .spatial_rules import RuleBase, RuleFinding


class RuleRegistry:
    """规则注册表（版本化，保留历史）。"""

    def __init__(self):
        # rule_id -> list[rule_instance]（按注册顺序，最新在尾）
        self._versions: Dict[str, List[RuleBase]] = {}
        # rule_id -> set(enabled rule_version)
        self._enabled: Dict[str, Set[str]] = {}

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
        versions = self._versions.get(rule_id)
        if not versions:
            return False
        if rule_version is None:
            rule_version = versions[-1].rule_version
        if any(r.rule_version == rule_version for r in versions):
            self._enabled.setdefault(rule_id, set()).add(rule_version)
            return True
        return False

    def disable(self, rule_id: str, rule_version: Optional[str] = None) -> bool:
        """禁用某 rule_id 的指定版本；未指定 version 则禁用其全部版本。"""
        if rule_id not in self._versions:
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
        return [r.rule_version for r in self._versions.get(rule_id, [])]

    def is_enabled(self, rule_id: str, rule_version: Optional[str] = None) -> bool:
        """判断某 rule_id（可指定版本）是否启用。"""
        if rule_id not in self._versions:
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
