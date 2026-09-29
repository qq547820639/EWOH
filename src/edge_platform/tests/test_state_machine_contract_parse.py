"""YLOAD-01（V331）：边缘侧的契约加载器必须读得到**每一份**状态机契约。

缺陷形状（本轮实测，不是推测）：`contracts/state-machines/*.yaml` 除了 states/transitions/terminal，
还装了与状态机无关的**兄弟块**（派生投影口径 `kpi_delivery_window`／`feedback_projection`／
`wave_completion`、通知身份 `*_notification_identity`、聚合口径 `aggregation`／`rings`、
`step_states`）。`parse_simple_yaml` 是"边缘零第三方依赖"下自研的极简子集解析器，那些嵌套行
在它这里一律走 else 分支抛 ValueError ⇒ 四个文件（plan/alert/approval/control）整体读不到状态机。
`tests/test_state_machine_contract.py` 的两条用例因此是红的。执行面现算：这份 pytest 只被
`make contract-state-machine`／`make test-contract`／CI 的 `make test-gated` 跑，
而**试点收尾那二十七条主线一条都不跑它** ⇒ 它红在这批未提交改动里若干轮无人见；
`git show HEAD:` 那份契约在同一把尺下可解析（读到 8 支箭头）⇒ 打断发生在未提交区间，提交那批改动就会让 CI 红。
门禁覆盖面那一格另记 CI-07，不在本文件里判。

本守卫回答三件事，且每件都必须是"能变红"的：
  1) 七份契约逐份加载成功，箭头数与文本面独立数法一致（跳过兄弟块不得把箭头一起吞掉）；
  2) 被跳过的兄弟块键名**可见**（`sibling_top_level_keys` 与文本面数出来的非建模顶层键逐一对上），
     这样"静默丢内容"与"正确地跳过"在断言上不同形；
  3) V331 补的 `kind:` 声明真的到达了边缘读者（每支箭头的 kind ∈ {action, guard}），
     并与 `contract-condition-labels` 那把 TS 尺吃的是同一个事实源；
  4) **YLOAD-03**（V332 实测踩中）：行内注释的剥离必须按 YAML 规范判定 `#` 的位置——
     旧写法把值里的 `#` 也当注释起点，`writer: 路径#标识符` 那种带锚点的值会把整行拦腰截断，
     内联映射丢掉右花括号后 fail-closed 抛 ValueError（plan/alert 两份契约整体读不到，5 条用例红）。
     修在解析器（`strip_comment`），契约写法保留；两个极性都要开火：值里的 `#` 必须逐字到达，
     行首与空白后的真注释仍必须被剥掉。
fail-closed 没有被放宽：`test_yload_02` 用合成源码证明 `transitions:` 内部的非子集形状仍然必须抛，
同时证明兄弟块里的怪形状不再抛——两个极性都要开火，只验一边等于没验。
"""

from __future__ import annotations

import pathlib
import re
import unittest

from edge_platform.contracts import state_machine_loader as sml

SM_DIR = pathlib.Path(__file__).resolve().parents[3] / "contracts" / "state-machines"
MODELED_TOP = ("states", "transitions", "terminal", "version", "owner")


def contract_files() -> list[pathlib.Path]:
    return sorted(p for p in SM_DIR.glob("*.y*ml"))


def text_top_level_keys(text: str) -> list[str]:
    """文本面独立数法：缩进 0 的 `key:` —— 与本文件的结构判据不同源，用来卡加载器漏读。"""
    return [m.group(1) for m in re.finditer(r"^([a-z_][a-z0-9_]*):", text, re.M)]


def text_arrow_lines(text: str) -> list[str]:
    """文本面独立数法：**只在 transitions 段内**数内联 flow 箭头行（`- { ... }` 且带 from/to）。

    不限定段就会把兄弟块里的 flow 行一起数进去（那是另一种假红）；段边界取下一个缩进 0 的键。
    """
    lines = text.splitlines()
    start = None
    for i, l in enumerate(lines):
        if re.match(r"^transitions:", l):
            start = i + 1
            break
    if start is None:
        return []
    out = []
    for l in lines[start:]:
        if re.match(r"^[a-z_][a-z0-9_]*:", l):
            break
        if re.match(r"^\s*- \{.*\bfrom:.*\bto:.*\}\s*$", l):
            out.append(l)
    return out


def text_writer_values(text: str) -> list[str]:
    """文本面独立数法：transitions 段内声明的 `writer` 值**原样**（含 `#标识符`）。

    与加载器不同源：这条正则不剥注释、不 split 冒号，所以"值被拦腰截断"在它面前藏不住。
    """
    out = []
    for l in text_arrow_lines(text):
        m = re.search(r"writer:\s*([^,}\s]+)", l)
        if m:
            out.append(m.group(1))
    return out


class StateMachineContractParseTest(unittest.TestCase):
    def test_yload_01_every_contract_file_loads(self):
        files = contract_files()
        self.assertGreaterEqual(len(files), 7, f"契约目录里只有 {len(files)} 份，分母不成立")
        total_loader = 0
        total_text = 0
        for path in files:
            text = path.read_text(encoding="utf-8")
            sm = sml.parse_simple_yaml(text)          # 任一文件抛 ValueError 即红在这里
            self.assertTrue(sm["transitions"], f"{path.name} 读不到任何 transitions")
            self.assertTrue(sm["states"], f"{path.name} 读不到任何 states")
            n_loader = len(sm["transitions"])
            n_text = len(text_arrow_lines(text))
            self.assertEqual(
                n_loader, n_text,
                f"{path.name}：加载器读到 {n_loader} 支箭头，文本面独立数法数到 {n_text} 支"
                f" ⇒ 跳过兄弟块的规则把箭头一起吞了（或反过来漏读）",
            )
            total_loader += n_loader
            total_text += n_text
        self.assertEqual(total_loader, total_text, "Σ(加载器) 与 Σ(文本面) 不闭合")
        self.assertGreaterEqual(total_loader, 50, "箭头总量突然掉档，先怀疑解析器而不是契约")

    def test_yload_01b_skipped_sibling_keys_are_visible(self):
        for path in contract_files():
            text = path.read_text(encoding="utf-8")
            sm = sml.parse_simple_yaml(text)
            want = [k for k in text_top_level_keys(text) if k not in MODELED_TOP]
            got = list(sm["sibling_top_level_keys"])
            self.assertEqual(
                sorted(set(want)), sorted(set(got)),
                f"{path.name}：文本面有非建模顶层键 {sorted(set(want))}，加载器只报了 {sorted(set(got))}"
                f" ⇒ 要么静默吞了一块，要么多认了一个它并不建模的键",
            )

    def test_yload_01c_kind_declarations_reach_the_edge_reader(self):
        for path in contract_files():
            sm = sml.parse_simple_yaml(path.read_text(encoding="utf-8"))
            for t in sm["transitions"]:
                self.assertIn(
                    t.get("kind"), ("action", "guard"),
                    f"{path.name}：箭头 {t.get('from')}→{t.get('to')} 的 kind={t.get('kind')!r}"
                    f" 不是 action/guard ⇒ 契约的动作/守卫声明没落到边缘这一侧",
                )

    def test_yload_02_fail_closed_still_holds_inside_modeled_keys(self):
        # 极性 A：transitions 内部出现非子集形状（块样式箭头）⇒ 必须抛，绝不猜结构
        block_style = (
            "states:\n  - a\n  - b\ntransitions:\n  - from: a\n    to: b\nterminal: [b]\n"
        )
        with self.assertRaises(ValueError, msg="transitions 内部的块样式箭头必须 fail-closed 抛错"):
            sml.parse_simple_yaml(block_style)

        # 极性 B：兄弟块里再怪的形状（多行 flow list、嵌套 mapping、带空格的值）都不该影响状态机读取
        sibling = (
            "states:\n  - a\n  - b\ntransitions:\n  - { from: a, to: b, condition: go, kind: action }\n"
            "terminal: [b]\nsome_projection:\n  source_table: t\n  keys: [x, y,\n    z]\n  nested:\n    deep: 1\n"
        )
        sm = sml.parse_simple_yaml(sibling)
        self.assertEqual(len(sm["transitions"]), 1, "兄弟块把唯一那支箭头挤掉了")
        self.assertEqual(sm["sibling_top_level_keys"], ["some_projection"])

    def test_yload_03_writer_anchor_survives_comment_strip(self):
        """YLOAD-03：`#` 只有在行首或前面是空白时才起注释 ⇒ 值里的 `#` 必须逐字到达箭头字典。"""
        src = (
            "states:\n  - a\n  - b\n"
            "transitions:\n  - { from: a, to: b, kind: action, writer: pkg/svc.py#do_it }\n"
            "terminal: [b]\n"
        )
        sm = sml.parse_simple_yaml(src)
        self.assertEqual(
            sm["transitions"],
            [{"from": "a", "to": "b", "kind": "action", "writer": "pkg/svc.py#do_it"}],
            "带 `#` 的 writer 被注释剥离拦腰截断 ⇒ 内联映射缺右花括号，YLOAD-03 复发",
        )

        total = 0
        for path in contract_files():
            text = path.read_text(encoding="utf-8")
            sm2 = sml.parse_simple_yaml(text)
            got = [t["writer"] for t in sm2["transitions"] if "writer" in t]
            want = text_writer_values(text)
            self.assertEqual(
                got, want,
                f"{path.name}：文本面声明 {want}，加载器只读到 {got} ⇒ 注释判定又不合规",
            )
            bad = [w for w in got if "#" not in w and w != "unimplemented"]
            self.assertFalse(bad, f"{path.name}：writer 值形状不合规（既无锚点也不是 unimplemented）{bad}")
            total += len(got)
        self.assertGreaterEqual(total, 8, f"契约里一共只读到 {total} 支 writer 声明，分母不成立")

    def test_yload_03b_line_comments_are_still_stripped(self):
        """反极性：放行值里的 `#` 不等于关掉注释剥离——行首与空白后的真注释仍必须被剥掉。"""
        src = (
            "# 顶部注释\nstates:\n  - a   # 行尾注释\n  - b\n"
            "transitions:\n  - { from: a, to: b, kind: guard } # 箭头后的说明\n"
            "terminal: [b]\n"
        )
        sm = sml.parse_simple_yaml(src)
        self.assertEqual(sm["states"], ["a", "b"], f"行尾注释没被剥掉：{sm['states']!r}")
        self.assertEqual(
            sm["transitions"], [{"from": "a", "to": "b", "kind": "guard"}],
            f"箭头行之后的注释没剥掉或剥多了：{sm['transitions']!r}",
        )


if __name__ == "__main__":
    unittest.main()
