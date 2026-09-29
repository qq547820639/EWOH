# -*- coding: utf-8 -*-
"""登记册一致性自检的判据自测（反向控制）：证明 `artifact-consistency.cjs` 真的能红。

只写副本目录 tmp/v97-rc/，真产物（文档、状态件、verify.sh）一个字节都不改。
十二种失效形状各注入一次，断言自检报出对应判据；另跑一次"干净副本"作对照（必须 0 项）。
用法：python3 scripts/chain-baseline/artifact-consistency.selftest.py
"""
import json
import os
import re
import shutil
import subprocess
import sys

RC = os.path.join(os.environ.get('TMPDIR', '/tmp'), 'ewoh-artifact-consistency-selftest')
DOC = 'docs/audit/current/chain-behavior-baseline.md'
PKG = 'docs/audit/current/pilot-promotion-verdict.md'
STATE = '.codex/artifacts/chain-behavior-baseline-state.json'
VERIFY = 'scripts/chain-baseline/verify.sh'
CHECKER = 'scripts/chain-baseline/artifact-consistency.cjs'

os.makedirs(RC, exist_ok=True)
doc0 = open(DOC, encoding='utf-8').read()
state0 = json.load(open(STATE, encoding='utf-8'))
verify0 = open(VERIFY, encoding='utf-8').read()


def _drop_last_vrow(doc):
    """删掉 §七 最后一行（不写死行号或轮次号：登记册每长一行，写死的注入就会失效）。"""
    lines = doc.split('\n')
    last = max(i for i, l in enumerate(lines) if l.startswith('| V'))
    return '\n'.join(lines[:last] + lines[last + 1:])


FACTS = 'tmp/chain-baseline/schema-facts.txt'


def run(doc, state, verify, pkg=None, facts=None, logs=None, unit_logs=None, unit_dirs=None):
    # V239：logs=[(相对目录, 文件名, passed 值, mtime 偏移秒)]，给出顺序即档位（第一个目录＝重放器规范档）。
    # 用来造「两份日志互相矛盾」——不注入就只能手工跑这条控制（V235 的三条控制就是这个状态）。
    dp, sp, vp = f'{RC}/doc.md', f'{RC}/state.json', f'{RC}/verify.sh'
    open(dp, 'w', encoding='utf-8').write(doc)
    json.dump(state, open(sp, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    open(vp, 'w', encoding='utf-8').write(verify)
    pp = f'{RC}/pkg.md'
    if pkg is not None:
        open(pp, 'w', encoding='utf-8').write(pkg)
    else:
        shutil.copyfile(PKG, pp)
    fp = f'{RC}/facts.txt'          # B 段事实文件（V116 第 12 项的核对对象）：默认取真产物副本
    if facts is None:
        if os.path.exists(FACTS):
            shutil.copyfile(FACTS, fp)
        else:
            facts = ''
    if facts is not None:
        open(fp, 'w', encoding='utf-8').write(facts)
    env_extra = {}
    if logs is not None:
        ordered, base_t = [], 1900000000
        for dname, fname, nval, moff in logs:
            dpath = os.path.join(RC, dname)
            os.makedirs(dpath, exist_ok=True)
            lpath = os.path.join(dpath, fname)
            open(lpath, 'w', encoding='utf-8').write('synthetic\nTests:       %d passed, %d total\n' % (nval, nval))
            os.utime(lpath, (base_t + moff, base_t + moff))
            if dpath not in ordered:
                ordered.append(dpath)
        env_extra = {'EWOH_AUDIT_LOG_DIRS': ','.join(ordered)}
    if unit_logs is not None:
        dpath = os.path.join(RC, 'unitdir')
        os.makedirs(dpath, exist_ok=True)
        base_u = 1900100000
        for fname, tval, sval, moff in unit_logs:
            lpath = os.path.join(dpath, fname)
            open(lpath, 'w', encoding='utf-8').write(
                'Test Suites: %d passed, %d total | Tests:       %d passed, %d total\n' % (sval, sval, tval, tval))
            os.utime(lpath, (base_u + moff, base_u + moff))
        dirs = [os.path.join(RC, d) for d in (unit_dirs or ['unitdir'])]
        for d in dirs:
            os.makedirs(d, exist_ok=True)
        env_extra['EWOH_AUDIT_UNIT_DIRS'] = ','.join(dirs)
    env = dict(os.environ, EWOH_AUDIT_DOC=dp, EWOH_AUDIT_STATE=sp, EWOH_AUDIT_VERIFY=vp,
               EWOH_AUDIT_PKG=pp, EWOH_AUDIT_FACTS=fp, **env_extra)
    r = subprocess.run(['node', CHECKER], capture_output=True, text=True, env=env)
    out = r.stdout + r.stderr
    run.last_rc = r.returncode
    probs = re.findall(r'^\s*✗ (.*)$', out, re.M)
    return out, probs


CASES = [
    ('R1 §七 末行被删（current_status 与验证记录脱钩）',
     lambda d, s, v, k: (_drop_last_vrow(d), s, v, k), '与 current_status'),
    ('R2 同一编号同时出现在 fixed 与 open（F-10b 当年的形状）',
     lambda d, s, v, k: (d, _crossdup(s), v, k), '同时出现在 fixed 与 open'),
    ('R2b findings.open 里同一编号出现两次（同侧重复）',
     lambda d, s, v, k: (d, _open_dup(s), v, k), '出现 2 次'),
    ('R3 状态件漏登记 §5.4 的一行（双写面不对称）',
     lambda d, s, v, k: (d, _drop_open(s), v, k), '§5.4 登记表行的编号不在状态件'),
    ('R4 current_status 的 fixed 计数写错（自述与数组不符）',
     lambda d, s, v, k: (d, _badcount(s), v, k), 'current_status 写 fixed='),
    ('R4b fixed_count_note 的自述计数写错',
     lambda d, s, v, k: (d, _badnote_fixed(s), v, k), 'fixed_count_note 写 fixed='),
    ('R4c fixed_count_note 的「§5.4 登记表 n 行」写错（V110 新增规则的召回位点）',
     lambda d, s, v, k: (d, _badnote_rows(s), v, k), 'fixed_count_note 写 §5.4'),
    ('R7 速览的「D 与 D2 各 N spec」与 CHAIN_SPECS 不一致',
     lambda d, s, v, k: (_bad_snap_spec(d), s, v, k), '速览写'),
    ('R8 速览的「§5.4 共 N 行——x 闭、y 开」写错（交接时最先读到的那一格）',
     lambda d, s, v, k: (_bad_snap_rows(d), s, v, k), '速览写'),
    ('R9 速览的门禁条数与 Makefile 真实条数不一致（两处必须一起改）',
     lambda d, s, v, k: (_bad_snap_gate(d), s, v, k), '条主线'),
    ('R5 CHAIN_SPECS 里塞一个不存在的 spec（清单与磁盘脱节）',
     lambda d, s, v, k: (d, s, v.replace('control-receipt-boundary', 'no-such-spec-xyz'), k),
     '清单里的 spec 文件不存在'),
    # R6 用正则改数字，不锚在具体读数上：V102 时 open 从 28 变 29，写死的注入就地静默失效
    # ——被"注入必须真的改变输入"这条守卫抓个正着（同 V98 的 R1 教训，这次是同族复发）。
    ('R10a §六「N 项已闭」与数组不符（收益度量表的历史数冒充现值这一类）',
     lambda d, s, v, k: (_bad_sec6_closed(d), s, v, k), '§六 写'),
    ('R10b §六 A 段 verify 读数与重放日志不符',
     lambda d, s, v, k: (_bad_sec6_verify(d), s, v, k), '§六 写 verify'),
    ('R10c §六 链级当期读数（spec 数）与 CHAIN_SPECS 不符',
     lambda d, s, v, k: (_bad_sec6_dcount(d), s, v, k), '§六 写'),
    ('R10d §六 全量单测当期读数与 unit-triage 归档不符',
     lambda d, s, v, k: (_bad_sec6_unit(d), s, v, k), '§六 写 后端单测'),
    ('R7 current_status 的门禁条数写错（状态件自述与 Makefile 主线数脱钩，V115 新加）',
     lambda d, s, v, k: (d, _badgates(s), v, k), 'current_status 写 gates='),
    ('R11a 速览的 B 段行数与事实文件不符（V116 新增第 12 项）',
     lambda d, s, v, k: (_bad_snap_brows(d), s, v, k), '速览写 B '),
    ('R11b B 段事实文件链相关表 0/18（连得上但库里什么都没有，V116 实测出的假绿形状）',
     lambda d, s, v, k: (d, s, v, k, _empty_facts()), '链相关表 0/18'),
    ('R6 裁决包引用的读数被改错（给人拍板的那一页过期）',
     lambda d, s, v, k: (d, s, v, re.sub(r'\d+ fixed / \d+ open', '99 fixed / 99 open', k)), '裁决包写 fixed='),
]



def _bad_snap_brows(doc):
    # 速览里「B N 行约束事实」的数字改错（正则派生，不锚在当期行数上）
    return re.sub(r'B \d+ 行约束事实', 'B 404 行约束事实', doc)


def _empty_facts():
    # V116 实测形状：探针连上一个空库，头行 0/18、正文只有段标题，旧版仍然 rc=0
    return ('public 表总数 0；链相关表 0/18\n\n=== 状态/时限列 ===\n'
            'SECTION 状态/时限列 rows=0\n\n=== CHECK 约束 ===\nSECTION CHECK 约束 rows=0\n')

def _crossdup(s):
    """把 fixed 里的 F-16 改名成 open 里已存在的 F-17：一个缺陷同时"已修"且"开放"。"""
    s = json.loads(json.dumps(s))
    victim = next(i for i, e in enumerate(s['findings']['fixed']) if e.startswith('F-16'))
    s['findings']['fixed'][victim] = s['findings']['fixed'][victim].replace('F-16', 'F-17', 1)
    return s


def _badgates(s):
    s = json.loads(json.dumps(s))
    cur = int(re.search(r'gates_(\d+)_mainlines', s['current_status']).group(1))
    s['current_status'] = s['current_status'].replace(f'gates_{cur}_mainlines', f'gates_{cur + 3}_mainlines')
    return s


def _open_dup(s):
    s = json.loads(json.dumps(s))
    victim = next(e for e in s['findings']['open'] if e.startswith('F-13'))
    s['findings']['open'].append(victim)
    return s


def _drop_open(s):
    s = json.loads(json.dumps(s))
    s['findings']['open'] = [e for e in s['findings']['open'] if not e.startswith('HTTP-01')]
    return s


def _sec6_span(doc):
    """§六 的切片边界——**逐字照尺子**（`artifact-consistency.cjs:354-355` 用按行锚的
    `startsWith('## 六、')` / `startsWith('## 七、')`）。V351 实测：这里若改成子串搜索 `doc.index('## 六')`，
    会撞上 §5.3 正文里那句「范围取 §5.4→`## 六`」的行内引用（该行并没有以 ## 六 开头），
    切片起点跑到 §五 之前 ⇒ 注入落到本轮 §5.3n60 的引文上、§六 一格未动，R10d 报 0 项。
    判据读的是这一段的当期读数，注入就必须落在这段里。"""
    lines = doc.split('\n')
    a = next(i for i, l in enumerate(lines) if l.startswith('## 六、'))
    b = next(i for i, l in enumerate(lines) if l.startswith('## 七、'))
    head = sum(len(l) + 1 for l in lines[:a])
    tail = sum(len(l) + 1 for l in lines[:b])
    assert doc[head:head + 5] == '## 六、' and doc[tail:tail + 5] == '## 七、', '§六 切片边界与尺子不同源'
    return head, tail


def _repl_in_sec6(doc, pat, fn, label):
    """V351 实测出来的修法：整篇 `re.search` + `replace(…,1)` 的四支 §六 注入会**跳到 §五**。
    起因＝本轮 §5.3n60 ① 引了一句 V349 的旧读数「后端单测 3694/3694 通过**（417 套件…」，
    它在 §六 之前 ⇒ R10d 改的是那句引文、§六 一格未动，判据报 0 项而被"注入必须改变输入"判成已注入。
    这里改成先切片、段内替换，再断言替换串确实落在重算的 §六 边界内——落点不在段内即 AssertionError。"""
    a, b = _sec6_span(doc)
    seg = doc[a:b]
    m = re.search(pat, seg)
    assert m, '§六 段内未命中注入锚点：%s（%s）' % (label, pat)
    old, new = m.group(0), fn(m)
    assert new != old, '注入未改变输入：%s' % label
    out = doc[:a] + seg.replace(old, new, 1) + doc[b:]
    a2, b2 = _sec6_span(out)
    assert out[a2:b2].count(new) == 1, '注入落点不在 §六 段内：%s' % label
    return out


def _bump_in_sec6(doc, pat, by, label):
    return _repl_in_sec6(doc, pat,
                         lambda m: re.sub(r'\d+', lambda x: str(int(x.group(0)) + by), m.group(0), count=1),
                         label)


def _bump(doc, pat, by, label):
    m = re.search(pat, doc)
    assert m, '注入锚点未命中：%s' % label
    old = m.group(0)
    new = re.sub(r'\d+', lambda x: str(int(x.group(0)) + by), old, count=1)
    assert new != old, '注入未改变输入：%s' % label
    return doc.replace(old, new, 1)


def _bad_snap_findings(doc):
    """V206：速览那句「口径记 **N fixed / M open**」——把它 bump 一下。
    判据第 11e 项必须抓到；抓不到就说明这一格又是没人核对的复制点。"""
    return _bump(doc, r'口径记 \*\*(\d+) fixed / (\d+) open\*\*', 3, '速览 findings')

def _bad_sec6_closed(doc):
    return _bump_in_sec6(doc, r'\*\*(\d+) 项已闭\*\*', 7, '已闭条目数')


def _bad_sec6_verify(doc):
    return _repl_in_sec6(doc, r'\*\*(\d+)/(\d+) verify PASS\*\*',
                         lambda m: '**%d/%d verify PASS**' % (int(m.group(1)) + 3, int(m.group(2)) + 3),
                         'A 段 verify')


def _bad_sec6_dcount(doc):
    return _bump_in_sec6(doc, r'当期读数 = (\d+) spec', 2, '链级当期 spec 数')


def _bad_sec6_unit(doc):
    return _bump_in_sec6(doc, r'后端单测 (\d+)/(\d+) 通过', 5, '全量单测当期读数')


def _badcount(s):
    """把 current_status 里的 `_<n>_fixed_` 改成另一个数——**不写死 n**：
    V110 时这个数从 26 变成 28，写死的 `_26_fixed_` 注入当场变成摆设（被"注入必须改变输入"抓到）。"""
    s = json.loads(json.dumps(s))
    m = re.search(r'_(\d+)_fixed_', s['current_status'])
    if not m:
        raise AssertionError('current_status 里没有 `_<n>_fixed_` 段，注入无从下手')
    n = int(m.group(1))
    s['current_status'] = s['current_status'].replace('_%d_fixed_' % n, '_%d_fixed_' % (n + 5), 1)
    return s


def _badnote_fixed(s):
    """fixed_count_note 的自述计数被改错。"""
    s = json.loads(json.dumps(s))
    note = s['findings']['fixed_count_note']
    m = re.search(r'fixed (\d+) 条', note)
    assert m, 'fixed_count_note 里没有「fixed n 条」可注入'
    s['findings']['fixed_count_note'] = note.replace(m.group(0), 'fixed %d 条' % (int(m.group(1)) + 3), 1)
    return s


def _badnote_rows(s):
    """V110 新增规则的召回位点：同一条注记里的「§5.4 登记表 n 行」以前根本没人核对，本轮记账就真的漏了它。"""
    s = json.loads(json.dumps(s))
    note = s['findings']['fixed_count_note']
    m = re.search(r'§5\.4 登记表 (\d+) 行', note)
    assert m, 'fixed_count_note 里没有「§5.4 登记表 n 行」可注入'
    s['findings']['fixed_count_note'] = note.replace(m.group(0), '§5.4 登记表 %d 行' % (int(m.group(1)) + 4), 1)
    return s


def _bad_snap_spec(doc):
    """速览里「D 与 D2 各 N spec」改错 ⇒ 与 CHAIN_SPECS 的真实长度对不上。"""
    m = re.search(r'D 与 D2 各 (\d+) spec', doc)
    assert m, '速览里没有「D 与 D2 各 N spec」可注入'
    return doc.replace(m.group(0), 'D 与 D2 各 %d spec' % (int(m.group(1)) + 1), 1)


def _bad_snap_rows(doc):
    """速览里「§5.4 共 N 行——x 行已闭、y 行开放」整体改错（交接时最先读到的那一格）。"""
    m = re.search(r'§5\.4 共 \*\*(\d+) 行——(\d+) 行已闭([^、]*)、(\d+) 行开放\*\*', doc)
    assert m, '速览里没有「§5.4 共 N 行…」可注入'
    old = m.group(0)
    new = old.replace('%d 行——' % int(m.group(1)), '%d 行——' % (int(m.group(1)) + 2), 1)
    new = new.replace('——%d 行已闭' % int(m.group(2)), '——%d 行已闭' % (int(m.group(2)) + 2), 1)
    assert new != old, '速览 §5.4 注入没有改变输入'
    return doc.replace(old, new, 1)


def _bad_snap_gate(doc):
    """速览的门禁条数与 Makefile 真实条数不一致（两处必须一起改）。"""
    m = re.search(r'防回归门禁 \*\*([一二三四五六七八九十]+)条主线\*\*', doc)
    assert m, '速览里没有「防回归门禁 N条主线」可注入'
    # V149：原来写死「二十七」——门禁涨到 27 条后这条注入变成空操作，被"注入必须真的改变输入"
    # 守卫当场抓出（同 V98/V102 的 R6 教训，第三次同族复发）。改成对**末位数字做结构变换**：
    # 永远与当前值不等，不需要随产物更新。
    cur = m.group(1)
    dig = '一二三四五六七八九'
    assert cur[-1] in dig, f'速览门禁条数末位不是个位数字（{cur}）⇒ 注入判据需改'
    wrong = cur[:-1] + dig[(dig.index(cur[-1]) + 1) % len(dig)]
    assert wrong != cur
    return doc.replace(m.group(0), m.group(0).replace(cur, wrong), 1)


def _dup_last_heading(doc):
    """把最后一个「### 小节标题」原样重复一份（R12 注入）。锚点取**结构**（最后一个标题行），
    不写死编号——V142 登记时我把新节写成 §5.3cm，而那个号 V120 早已占用，悬空引用查不出来。"""
    lines = doc.split('\n')
    idx = max((i for i, l in enumerate(lines) if l.startswith('### ')), default=-1)
    assert idx > 0, '文档里没有 ### 小节标题可注入'
    lines.insert(idx + 1, lines[idx])
    out = '\n'.join(lines)
    assert out != doc, '注入没有改变输入（R12 会静默失效）'
    return out


def _bad_snap_findings(doc):
    """V206：速览那句「口径记 **N fixed / M open**」bump 一下。
    判据第 11e 项必须抓到；抓不到就说明这一格又是没人核对的复制点（V205 实际漏改过一次）。"""
    return _bump(doc, r'口径记 \*\*(\d+) fixed / (\d+) open\*\*', 3, '速览 findings')


def _drop_bucket_item(doc):
    """V206：把 §6.2 最后一个桶（E）条目列的末项摘掉，数量列不动。
    判据第 11f 项必须同时抓到「数量列≠条目列」和「在 findings.open 里但桶表未列」。
    锚点取**结构**（`### 6.2` 之后**第一段连续**的 `| A–E |` 行的末行），不写死桶字母或数量——
    §6.2 下面还压着 V127/V162 两张历史表，取"全文件最后一行"会注进历史表：判据看得见、注入摸不着。"""
    lines = doc.split('\n')
    row = re.compile(r'^\|\s*[A-E]\s*\|')
    head = max((i for i, l in enumerate(lines) if l.startswith('### 6.2')), default=-1)
    assert head > 0, '文档里没有 §6.2 小节可注入'
    start = next((i for i in range(head + 1, len(lines)) if row.match(lines[i])), -1)
    assert start > 0, '§6.2 之后找不到桶表行可注入'
    idx = start
    while idx + 1 < len(lines) and row.match(lines[idx + 1]):
        idx += 1
    cells = lines[idx].split('|')
    items = [s for s in cells[4].split('、') if s.strip()]
    assert len(items) >= 2, '当期表末桶条目列不足两项，注入无意义'
    cells[4] = ' ' + '、'.join(items[:-1]) + ' '
    lines[idx] = '|'.join(cells)
    out = '\n'.join(lines)
    assert out != doc, '§6.2 注入没有改变输入（R14 会静默失效）'
    return out


CASES.append(('R14 §6.2 归属桶条目列少一项而数量列未改（V205「加总 64/65」漂移的形状，V206 新增 11f）',
              lambda d, s, v, k: (_drop_bucket_item(d), s, v, k), '§6.2 归属桶表与开放项不符'))

CASES.append(('R13 速览的 findings 自述与数组不符（V206 新增：这一格此前无人核对）',
     lambda d, s, v, k: (_bad_snap_findings(d), s, v, k), '速览写 fixed='),)

CASES.append(('R12 小节号重复（同名 § 引用会指到先出现的那节，V142 自家事故）',
              lambda d, s, v, k: (_dup_last_heading(d), s, v, k), '小节号重复'))

pkg0 = open(PKG, encoding='utf-8').read()
base_out, base_probs = run(doc0, state0, verify0, pkg0)
if base_probs and run.last_rc == 0:
    print('✘ 对照有 %d 项漂移但自检退出码仍是 0 ⇒ 判决通道断了（GATE-08 形状）' % len(base_probs))
print('对照（未注入的副本）：%s（rc=%s）' % ('0 项 ✔' if not base_probs else '%d 项 ✘ 尺子本身有噪声' % len(base_probs), getattr(run, 'last_rc', '?')))
for p in base_probs:
    print('   残留:', p[:140])

fails = []
for name, mutate, keyword in CASES:
    res = mutate(doc0, json.loads(json.dumps(state0)), verify0, pkg0)
    d, s, v, k, f = tuple(list(res) + [None])[:5]
    if (d, s, v, k, f) == (doc0, state0, verify0, pkg0, None):
        print('✘ %s → 注入根本没改变输入（锚点已随产物漂移，这条注入是摆设）' % name)
        fails.append(name + '（注入静默失效）')
        continue
    out, probs = run(d, s, v, k, f)
    hit = [p for p in probs if keyword in p]
    # 判决通道也要断言：V116 实测本自检从来没有 process.exit（GATE-08），注入只能"打印"不能"变红"，
    # 于是这一层判据对任何看退出码的调用方都是摆设。只认打印不认退出码 = 自测自己也是摆设。
    ok = bool(hit) and len(probs) > len(base_probs) and run.last_rc != 0
    print('%s %s → 报 %d 项，含判据「%s」%s' % ('✔' if ok else '✘', name, len(probs), keyword,
                                              '' if ok else '（未抓到！）'))
    if hit:
        print('    实际报语:', hit[0][:150])
    if not ok:
        fails.append(name)

# V239：passed 真值源分档的三条控制（两条必须红、一条必须不红）。当期 passed 值现抽，不写死数字。
EXTRA = []
_mp = re.search(r'D 与 D2 各 \d+ spec / (\d+) 条 passed', doc0)
DP = int(_mp.group(1)) if _mp else None
if DP is not None:
    _o, _p = run(doc0, state0, verify0, pkg0, logs=[
        ('h0', 'notes.txt', DP, 0), ('s0', 'v999-replay.log', DP + 3, 0)])
    EXTRA.append(('C1 规范档无可读文件、只有顶层手抄日志且与文档不符 ⇒ 必须红并报手抄的值（兜底档确实在读数）',
                  any(('条 passed' in x) and str(DP + 3) in x for x in _p) and run.last_rc != 0, _p[:1]))
    _o, _p = run(doc0, state0, verify0, pkg0, logs=[
        ('h1', 'notes.txt', DP, 0), ('s1', 'notes2.txt', DP, 0)])
    EXTRA.append(('C4 两档都没有 `Tests:` 汇总行 ⇒ 必须单列「不可判」，不许折成干净（V239 首跑就是这条抓出静默）',
                  any('不可判' in x for x in _p) and run.last_rc != 0, _p[:1]))
    _o, _p = run(doc0, state0, verify0, pkg0, logs=[
        ('hl', 'chain-specs.log', DP, -3600), ('sl2', 'v999-replay.log', DP + 9, 3600)])
    EXTRA.append(('C2 规范日志更旧但值与文档一致、手抄日志更新且值不同 ⇒ 不得报 passed 漂移（档位优先于 mtime）',
                  not any('条 passed' in x for x in _p), _p[:1]))
    _o, _p = run(doc0, state0, verify0, pkg0, logs=[
        ('hl2', 'chain-specs.log', DP + 5, -3600), ('sl3', 'v999-replay.log', DP, 3600)])
    EXTRA.append(('C3 规范日志与文档不符、手抄日志更新且与文档一致 ⇒ 必须红并报规范档的值（方向控制，防 C2 靠"读最新"蒙对）',
                  any(('条 passed' in x) and str(DP + 5) in x for x in _p), _p[:1]))
# V351 UARCH-01：§六「点名的单测归档」必须与它旁边抄的三个数同源（两红两不红）。
# U2 是关键那条：**最新一份与文档相符、点名的那一份不符** ⇒ 旧的那条"只比最新一份"永远看不见，
# 只有新判据看得见（两向同框）。U1 是假阳性面（两份都相符必须不开火），U4 是第三态（产物集为空不得红）。
_um = re.search(r'当期读数（V\d+，同一份定稿树：后端单测 (\d+)/(\d+) 通过\*\*（(\d+) 套件，rc=0，归档 `([^`]+)`', doc0)
if _um:
    _t, _k, _nm = int(_um.group(1)), int(_um.group(3)), _um.group(4)
    _A, _B = 'unit-20260101-000001.log', 'unit-20260102-000002.log'

    # 换名必须落在 §六 那一格上：同一个 `归档 \`X\`` 字面量本轮也出现在 §5.3 的正文里（第一处!),
    # 裸 replace(…,1) 会改到那句叙述、§六 原封不动 —— 控制就成了假对照。
    _CLAIM_LIT = re.compile(r'(当期读数（V\d+，同一份定稿树：后端单测 \d+/\d+ 通过\*\*（\d+ 套件，rc=0，归档 )`[^`]+`')

    def _named(nm):
        return _CLAIM_LIT.sub(lambda m: m.group(1) + '`%s`' % nm, doc0, count=1)

    _o, _p = run(_named(_A), state0, verify0, pkg0,
                 unit_logs=[(_A, _t, _k, 0), (_B, _t, _k, 60)])
    EXTRA.append(('U1 点名的归档在产物集里、它的汇总行与抄的三个数相符 ⇒ 不得开火（假阳性面为零）',
                  not any('点名的' in x for x in _p), _p[:1]))
    _o, _p = run(_named(_A), state0, verify0, pkg0,
                 unit_logs=[(_A, _t - 5, _k - 1, 0), (_B, _t, _k, 60)])
    EXTRA.append(('U2 最新一份与文档相符、**点名的那一份不符** ⇒ 必须红并报点名的归档与其汇总行（旧判据只看最新一份，看不见这一档）',
                  any(('点名的' in x and _A in x) for x in _p) and run.last_rc != 0, _p[:1]))
    _o, _p = run(_named('unit-20269999-999999.log'), state0, verify0, pkg0,
                 unit_logs=[(_A, _t, _k, 0), (_B, _t, _k, 60)])
    EXTRA.append(('U3 点名一个产物集里根本没有的归档 ⇒ 必须红并报「不在产物集里」，不许折成"没有这条判据"）',
                  any('不在产物集里' in x for x in _p) and run.last_rc != 0, _p[:1]))
    _o, _p = run(_named(_A), state0, verify0, pkg0, unit_logs=[], unit_dirs=['unitempty'])
    EXTRA.append(('U4 产物集为空（没有任何 unit 归档）⇒ 归档定名必须走"不可判"，既不红也不折成一致',
                  not any('点名的' in x for x in _p) and run.last_rc == 0, _p[:1]))
# V248：R 节自述核对的三条控制（两条必须红、一条合规侧必须不红）。节数由 pkg 现算，不写死。
_r0 = re.search(r'^## 四·补[^（\n]*（R1\.\.R(\d+)', pkg0, re.M)
_rn = len([l for l in pkg0.split('\n') if re.match(r'^### R\d+', l)])
if _r0 and int(_r0.group(1)) == _rn:
    _pk_bad = pkg0.replace('R1..R%d' % _rn, 'R1..R%d' % (_rn + 1), 1)
    _o, _p = run(doc0, state0, verify0, pkg=_pk_bad)
    EXTRA.append(('R1 §四·补 标题声明的 R 范围比实有节数多 1 ⇒ 必须红并报「节数 ≠ 声明」（V245 吃掉 R14 标题就是这一形状）',
                  any('R 节数' in x and str(_rn + 1) in x for x in _p) and run.last_rc != 0, _p[:1]))
    _i = _rn - 1
    _lines = pkg0.split('\n')
    _dup = [_n for _n, _l in enumerate(_lines) if re.match(r'^### R\d+', _l)][_i]
    _id = re.match(r'^### R(\d+)', _lines[_dup]).group(1)
    _pk_dup = '\n'.join(_lines[:_dup] + [_lines[_dup].replace('### R' + _id + ' ', '### R%d ' % (int(_id) - 1), 1)] + _lines[_dup + 1:])
    _o, _p = run(doc0, state0, verify0, pkg=_pk_dup)
    EXTRA.append(('R2 两节同号（改号/并单撞号）⇒ 必须单列「R 节编号重复」',
                  any('编号重复' in x for x in _p) and run.last_rc != 0, _p[:1]))
    _o, _p = run(doc0, state0, verify0, pkg0)
    EXTRA.append(('R3 真产物（节数＝声明数、编号唯一）⇒ 这两条判据都不得开火（合规侧对照）',
                  not any(('R 节数' in x) or ('编号重复' in x) for x in _p), _p[:1]))
# V250：11j「速览首段轮次号」的控制（V262 起为四条：三红一不红）。真值由状态件现抽，不写死轮次号。
_cs = re.search(r'pilot_through_V(\d+)', state0.get('current_status', ''))
_ovl = [l for l in doc0.split('\n') if l.startswith('**当前状态速览（V')]
_ov = re.match(r'\*\*当前状态速览（V(\d+)', _ovl[0]) if _ovl else None
if _cs and _ov and int(_cs.group(1)) == int(_ov.group(1)):
    _stale = doc0.replace('**当前状态速览（V' + _ov.group(1), '**当前状态速览（V%d' % (int(_ov.group(1)) - 1), 1)
    _o, _p = run(_stale, state0, verify0, pkg0)
    EXTRA.append(('O1 速览首段落后一轮（V247 漏写 prepend 的真实形状）⇒ 必须红并报「速览首段写 V」',
                  any('速览首段写 V' in x for x in _p) and run.last_rc != 0, _p[:1]))
    _wipe = doc0.replace('**当前状态速览（V' + _ov.group(1), '**当前状态速览（', 1)
    _o, _p = run(_wipe, state0, verify0, pkg0)
    EXTRA.append(('O2 速览首段被擦成没有轮次号形状 ⇒ 必须单列「轮次号无从核对」，不得折成已核对',
                  any('轮次号无从核对' in x for x in _p) and run.last_rc != 0, _p[:1]))
    _o, _p = run(doc0, state0, verify0, pkg0)
    EXTRA.append(('O3 真产物（速览轮次号＝current_status 最新轮次）⇒ 该判据不得开火（合规侧对照）',
                  not any('速览首段' in x for x in _p), _p[:1]))
    # O4（V262 新增）：**假绿方向**的对照——声明位被换成非数字，但同一段落别处仍留着正确的轮次号。
    # 旧实现对全文做 match，于是最新那段没号时会顺势读到**次新段**的号（速览顶部是逐轮累积的多段），
    # 把「形状坏了」报成「落后一轮」（V261 收尾时 O2 就是这样失效的）。判据改成只认第一个标题的声明位。
    _slot = '**当前状态速览（V%d 收尾时点' % int(_ov.group(1))
    _stray = doc0.replace(_slot, '**当前状态速览（本轮 收尾时点（V%d' % int(_ov.group(1)), 1)
    _o, _p = run(_stray, state0, verify0, pkg0)
    EXTRA.append(('O4 声明位换成非数字、段内别处仍有正确号 ⇒ 必须单列「轮次号无从核对」（防把别处的号当已核对）',
                  any('轮次号无从核对' in x for x in _p) and run.last_rc != 0, _p[:1]))
    # P1/P2（V262 新增）：同一病的**假绿面**。五处自述原先都 match 整段速览前缀（顶部是滚动三段），
    # 最新那段缺句时会读次新段的旧值；findings／spec／门禁条数在连轮之间常常同值 ⇒ 漏写被静默放行。
    # P1 从首段删掉 findings 那一句 ⇒ 必须报「速览未写」；P2 只从**次新段**删 ⇒ 不得报（假阳性面为零）。
    _fxm = re.search(r'口径记 \*\*\d+ fixed / \d+ open\*\*', doc0)
    if _fxm:
        _p1doc = doc0.replace(_fxm.group(0), '', 1)
        _o, _p = run(_p1doc, state0, verify0, pkg0)
        EXTRA.append(('P1 首段漏写 findings 自述（旧段留着同一句）⇒ 必须报「速览未写「口径记」」，不得静默放行',
                      any('速览未写「口径记' in x for x in _p) and run.last_rc != 0, _p[:1]))
    # P2（V262）：收窄到首段之后，**删掉旧段**不该影响任何核对（真产物仍全绿）。这条是假阳性面：
    # 用「删次新段」而不是「在同一句上再来一次」，因为旧段各轮写法不一（V260 写的是「状态件记」），
    # 同一 canonical 串在全文往往只有一份——P1 能开火本身就是这个事实的证明。
    _hl = [i for i, x in enumerate(doc0.split('\n')) if x.startswith('**当前状态速览')]
    if len(_hl) >= 2:
        _dl = doc0.split('\n')
        del _dl[_hl[1]]
        _o, _p = run('\n'.join(_dl), state0, verify0, pkg0)
        EXTRA.append(('P2 删掉一段**旧的**速览（首段完好）⇒ 五处自述仍须全部对上，不得开火（假阳性面必须为零）',
                      not any('速览' in x for x in _p) and run.last_rc == 0, _p[:1]))
# V252：R 范围自述的「写法面」——V248 只认 `R1..R<n>`，V251 撞到的那处写的是 `（R1–R12）`（连字符）。
_h4 = '## 四、推广前必须由他人拍板的事项（试点不代答）'
if _r0 and int(_r0.group(1)) == _rn and _h4 in pkg0:
    _hy = _rn - 3
    _pk_hy = pkg0.replace(_h4, _h4 + '（R1–R%d）' % _hy, 1)
    _o, _p = run(doc0, state0, verify0, pkg=_pk_hy)
    EXTRA.append(('H1 标题里用连字符自述 R1–R<n> 且比实有节数少 3 ⇒ 必须红并报「范围自述与节数不符」（V251 撞到的正是这种写法）',
                  any('范围自述与节数不符' in x and str(_hy) in x for x in _p) and run.last_rc != 0, _p[:1]))
    _pk_prose = pkg0.replace(_h4, _h4 + '\n\n散文引子：本单 R1–R%d 那两项同问。' % _hy, 1)
    _o, _p = run(doc0, state0, verify0, pkg=_pk_prose)
    EXTRA.append(('H2 同样的连字符写在**散文**里（子集引用是合法表述）⇒ 该判据不得开火（假阳性面必须为零）',
                  not any('范围自述与节数不符' in x for x in _p), _p[:1]))
    _o, _p = run(doc0, state0, verify0, pkg0)
    EXTRA.append(('H3 真产物（各处标题的范围写法都对上实有节数）⇒ 该判据不得开火（合规侧对照）',
                  not any('范围自述与节数不符' in x for x in _p), _p[:1]))
# V266：状态件两处自述的读取面。`current_status` 是「｜」分隔的**逐轮前缀串**，
# `fixed_count_note` 是「（V<nnn> 复算：」起头的**逐轮条串**——两处的"全文首个命中"都会让旧段替新段说话。
# 实物证据：V262–V264 三轮把新前缀写成**空格**分隔，而 `_NNN_fixed_NNN_open` 的正则要下划线开头，
# 于是连续四轮首命中落在 V261 段（V265 记账时实测 index 624），只因那几轮 findings 恰好没变才没报错。
# 下面六支：Q1/Q2/Q3/Q5 必须红（Q1、Q5 是"漏写被报成读旧段"那一族），Q4/Q6 是合规侧必须不开火。
_cst0 = str(state0.get('current_status', ''))
_segs = _cst0.split('｜')


def _mk_state(cs=None, note=None):
    s = json.loads(json.dumps(state0))
    if cs is not None:
        s['current_status'] = cs
    if note is not None:
        s['findings']['fixed_count_note'] = note
    return s


_head_has = re.search(r'_(\d+)_fixed_(\d+)_open', _segs[0]) if len(_segs) >= 2 else None
# 旧段的"正确值"不能靠产物历史（V262–V264 那几段本来就是空格分隔，正则看不见它们）——
# 靠历史会让整块控制在某天起静默跳过，而"静默跳过的控制"正是 V262 P2 抓到过的假控制形状。
# 这里按构造补一段**已知含正确值**的旧段，条件永远成立，四支控制不会集体隐身。
assert _head_has, 'Q 组前提不成立：current_status 首段没有 _N_fixed_N_ 段可注入（判据已改名或写法变了，须先看这里）'
_stale_tail = '｜pilot_through_V900_synth_stale_segment _%s_open' % _head_has.group(0).lstrip('_')
# Q1 复现 V262–V264 的真实形状：首段那件的**下划线换成空格**，旧段一字未动仍留着可匹配的数。
# 旧实现此时会去读旧段 ⇒ 报「写 fixed=旧值」（把漏写说成写错）；新实现必须单列「首段未带」。
_q1cs = _segs[0].replace('_%d_fixed_' % int(_head_has.group(1)),
                         ' %d_fixed_' % int(_head_has.group(1)), 1) + _stale_tail
assert _q1cs != _cst0, 'Q1 注入没有改变输入（首段写法已变，判据无从验证）'
_o, _p = run(doc0, _mk_state(cs=_q1cs), verify0, pkg0)
EXTRA.append(('Q1 首段的 _N_fixed_N_ 被写成空格分隔（V262–V264 的真实写法），旧段仍留可匹配旧值 ⇒ '
              '必须单列「current_status 首段未带」，不得读旧段把漏写报成写错值',
              any('current_status 首段未带' in x for x in _p) and run.last_rc != 0, _p[:1]))
# Q2 方向控制（防 Q1 靠"反正会红"蒙对）：首段写**错值**、旧段写**对值** ⇒ 必须红并报首段那个错数。
_q2cs = _segs[0].replace('_%d_fixed_' % int(_head_has.group(1)),
                         '_%d_fixed_' % (int(_head_has.group(1)) + 7), 1) + _stale_tail
assert _q2cs != _cst0, 'Q2 注入没有改变输入'
_o, _p = run(doc0, _mk_state(cs=_q2cs), verify0, pkg0)
EXTRA.append(('Q2 首段 fixed 自述比数组多 7、旧段仍是正确值 ⇒ 必须红并报**首段**的数（证明真值源是首段，不是首个能匹配上的段）',
              any('current_status 写 fixed=%d' % (int(_head_has.group(1)) + 7) in x for x in _p) and run.last_rc != 0, _p[:1]))
# Q3 首段摘掉 chain_specs 那件 ⇒ 必须单列 chain_specs 首段未带（同一条病的第二件）。
_m3 = re.search(r'chain_specs_\d+_\d+_ ', _segs[0])
if _m3:
    _q3cs = _segs[0].replace(_m3.group(0), '', 1) + _stale_tail
    assert _q3cs != _cst0, 'Q3 注入没有改变输入'
    _o, _p = run(doc0, _mk_state(cs=_q3cs), verify0, pkg0)
    EXTRA.append(('Q3 首段没有 chain_specs_<n>_<tests> 段（旧段有）⇒ 必须单列「首段未带 chain_specs」，不得折成已核对',
                  any('首段未带 chain_specs' in x for x in _p) and run.last_rc != 0, _p[:1]))
# Q4 合规侧：真产物的四件自述都在首段 ⇒ 三条「首段未带」都不许开火（假阳性面必须为零）。
_o, _p = run(doc0, state0, verify0, pkg0)
EXTRA.append(('Q4 真产物（首段齐带 pilot/chain_specs/gates/_fixed_）⇒ 「首段未带」各条不得开火（假阳性面必须为零）',
              not any('首段未带' in x for x in _p), _p[:1]))
# Q5 note 侧：前插一条不含两个自述短语的新条（旧条留着正确计数）⇒ 必须报两处「首条未写」。
_nt0 = str(state0['findings']['fixed_count_note'])
if re.search(r'fixed \d+ 条 / open \d+ 条', _nt0) and re.search(r'§5\.4 登记表 \d+ 行', _nt0):
    _q5note = '（V999 复算：本条故意只写事，不带任何自述计数）' + _nt0
    assert _q5note != _nt0, 'Q5 注入没有改变输入'
    _o, _p = run(doc0, _mk_state(note=_q5note), verify0, pkg0)
    EXTRA.append(('Q5 fixed_count_note 前插一条不含自述的新条（旧条仍有正确值）⇒ 必须报两处「首条未写」，'
                  '不得读旧条把漏写静默放行（V265 记账正是靠 prepend，这条随时会重演）',
                  sum(1 for x in _p if 'fixed_count_note 首条未写' in x) >= 2 and run.last_rc != 0, _p[:1]))
    _o, _p = run(doc0, state0, verify0, pkg0)
    EXTRA.append(('Q6 真产物（首条齐写「fixed n 条 / open m 条」与「§5.4 登记表 n 行」）⇒ 两条判据不得开火',
                  not any('首条未写' in x for x in _p), _p[:1]))

for name, ok_, detail in EXTRA:
    if not ok_:
        fails.append(name)
    print('%s %s%s' % ('✔' if ok_ else '✘', name, '' if ok_ else '    实际报语: %s' % (detail,)))

print('\n结论：%s（%d/%d 抓到；对照 %d 项）' % (
    '尺子可红，V97 的"干净"读数有效' if not fails and not base_probs else '尺子不可信',
    len(CASES) + len(EXTRA) - len(fails), len(CASES) + len(EXTRA), len(base_probs)))
shutil.rmtree(RC)   # 副本用完即删，真产物从未被写
sys.exit(1 if (fails or base_probs) else 0)
