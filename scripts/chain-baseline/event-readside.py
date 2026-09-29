# -*- coding: utf-8 -*-
# 契约事件**读侧**普查（V137 建立，常驻可复算）：谁在按名消费这条事件？三面合账的第三面
# 依赖 tmp/event-roles.json（make chain-baseline-event-roles）与 tmp/event-payload.json（make chain-baseline-event-payload）的读数，故 make 目标会先跑这两件。
#
#   声明（目录 70 条）／写（V135 角色 + V136 载荷形状）／读（本轮）。
# 要找的是**死等**：有消费分支在等一条无人构造的事件；以及反面：发了没人按名接。
#
# 三条从上一轮踩坑里学来的规矩，都写进判据：
#  ① 身份只取已枚举的权威清单（70 通道 + 未登记名），不新造"名字形状"过滤——
#     `(eventType|type) === 'x'` 那种宽匹配会把附件/无障碍/tiptap 的 `type === 'x'` 全卷进来。
#  ② 判定**顺序即语义**：先读后写。`eventType === 'x'` 同时含 `eventType =` 与 `===`，
#     先判 emit 就把比较全吃成写入（实测只数出 3 个消费位点）。
#  ③ 比较还分**平面**：服务端写库时 `eventCode: eventType === 'X' ? … : …` 是产出方在选列值，
#     不是消费者（15 条命中里 11 条是这种）。读面 = 客户端 / ingest 入口 / 边缘桥接与路由。
#
# 夹具自测证明"死等"抓得住（注入一行读面比较必须报、删掉必须不报）。
# 注意：夹具是**未跟踪文件**，git grep 看不见 ⇒ 直接把文件内容喂给同一条扫描函数。
import io
import json
import os
import re
import subprocess
import sys

Y = 'contracts/events/event-catalog.yaml'
SCAN = ['src', 'ewoh-spark-app/server', 'ewoh-spark-app/shared', 'ewoh-spark-app/client/src']
PROJ_BASES = ('event_catalog.py', 'event-catalog.ts')
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
)
ROLES = os.path.join(ROOT, 'tmp/event-roles.json')
PAY = os.path.join(ROOT, 'tmp/event-payload.json')
OUT = os.path.join(ROOT, 'tmp/event-readside.json')
FIX = os.path.join(ROOT, 'tmp/v137-fixture')

CMP_RE = re.compile(r"(===|!==|==|case\s+)")
SUB_RE = re.compile(r"(@OnEvent|\.subscribe\(|\bon\(|addEventListener|fromEvent|watch\()")
MEM_RE = re.compile(r"(\.includes\(|new Set\(|indexOf\(|\.has\()")
COMMENT_RE = re.compile(r'^\s*(//|\*|/\*|#)')
EMIT_RE = re.compile(r'(enqueue|enqueueThrottled|_publish|publishEvent|publish)\s*\(|'
                     r"""['"]?(eventType|event_type|sseType)['"]?\s*[:=]""")
TEST_RE = re.compile(r'(\.spec\.|\.test\.|__tests__|/tests/|test_)')
PREFIX_RE = re.compile(r"""['"]([a-z][a-z0-9_]*\.)['"]""")
# 用**路径段**而不是仓库根前缀：夹具在 tmp/ 下，带根前缀的规则对它永远不命中 ⇒ 自测不开火
READ_PLANE = ('/client/src', '/modules/ingest', '/edge/bridge', '/routes/')
READ_KINDS = ('subscribe', 'compare', 'membership')
PREFIXES = set()


def sh(a):
    return subprocess.run(a, capture_output=True, text=True)


def plane_of(f):
    # 前缀 + 目录段双判：夹具在 tmp/ 下，只按仓库根前缀会把它算成写面 ⇒ 自测永远不开火
    return 'read' if any(p in f for p in READ_PLANE) else 'write'


def classify_line(ln):
    if COMMENT_RE.match(ln):
        return 'comment'
    if SUB_RE.search(ln):
        return 'subscribe'
    if CMP_RE.search(ln):
        return 'compare'
    if MEM_RE.search(ln):
        return 'membership'
    if EMIT_RE.search(ln):
        return 'emit-or-envelope'
    return 'other'


def parse_catalog():
    lines = io.open(Y, encoding='utf-8').read().split('\n')
    section, cur_ch, cur_msg = None, None, None
    chan_msg, msg_type = {}, {}
    for ln in lines:
        if re.match(r'^channels:\s*$', ln):
            section = 'channels'; continue
        if re.match(r'^components:\s*$', ln):
            section = 'components'; continue
        if re.match(r'^  messages:\s*$', ln):
            section = 'messages'; continue
        if section == 'channels':
            cm = re.match(r'^  ([\w.-]+):\s*$', ln)
            if cm:
                cur_ch = cm.group(1); continue
            rm = re.search(r"\$ref: '#/components/messages/(\w+)'", ln)
            if rm and cur_ch:
                chan_msg[cur_ch] = rm.group(1); cur_ch = None
        elif section == 'messages':
            mm = re.match(r'^    (\w+):\s*$', ln)
            if mm:
                cur_msg = mm.group(1); continue
            tm = re.match(r'^ +type:\s*(com\.ewoh\.[\w.]+)\s*$', ln)
            if tm and cur_msg and cur_msg not in msg_type:
                msg_type[cur_msg] = tm.group(1); cur_msg = None
    return chan_msg, msg_type


def rx(names):
    pats = [r'(?<!\w)(?:com\.ewoh\.)?%s(?!\w)' % re.escape(n).replace('\\_', '[._]') for n in names]
    return re.compile('|'.join(pats))


def build_corpus():
    pats = [(['-E', '-e'], r"""['"][a-z][a-z0-9_]*(\.[a-z][a-z0-9_]+)+['"]"""),
            (['-F', '-e'], 'eventType'), (['-F', '-e'], 'event_type'),
            (['-F', '-e'], 'subscribe'), (['-F', '-e'], 'case ')]
    files = []
    for flags, pt in pats:
        files += sh(['git', 'grep', '-l'] + flags + [pt, '--'] + SCAN).stdout.split()
    per = {}
    for f in sorted({x for x in files if not x.endswith('.pyc') and x.split('/')[-1] not in PROJ_BASES}):
        try:
            per[f] = io.open(f, encoding='utf-8', errors='ignore').read().split('\n')
        except OSError:
            pass
    return per


def collect_prefixes(per):
    out = set()
    for f, txt in per.items():
        if TEST_RE.search(f):
            continue
        for ln in txt:
            if COMMENT_RE.match(ln):
                continue
            for m in PREFIX_RE.finditer(ln):
                out.add(m.group(1))
    return out


def scan_identities(per, ident, constructed, declared):
    rows = []
    for name, names in sorted(ident.items()):
        r = rx(names)
        kinds = {}
        for f, txt in per.items():
            if TEST_RE.search(f):
                continue
            for i, ln in enumerate(txt):
                if not r.search(ln):
                    continue
                k = classify_line(ln)
                if k in READ_KINDS and plane_of(f) == 'write':
                    k = 'write-side-branch'
                kinds.setdefault(k, []).append((f, i + 1, ln.strip()[:120]))
        read = [k for k in READ_KINDS if k in kinds]
        rows.append({'name': name, 'constructed': name in constructed, 'declared': name in declared,
                     'read_kinds': read, 'prefix_covered': any(name.startswith(p) for p in PREFIXES),
                     'evidence': {k: v[:3] for k, v in kinds.items()}})
    return rows


def identities():
    chan_msg, _ = parse_catalog()
    raw = json.load(io.open(PAY, encoding='utf-8'))['undeclared']
    undecl = sorted(raw if isinstance(raw, dict) else {u['name'] for u in raw})
    ident = {ch: sorted({ch, ch.replace('.', '_'), msg}) for ch, msg in chan_msg.items()}
    for u in undecl:
        ident[u] = sorted({u, u.replace('.', '_')})
    return chan_msg, ident, undecl


def self_test():
    _, ident, _ = identities()
    probe = 'plan.approved'                 # V135 判"无构造点"的目录事件
    fxp = os.path.join(FIX, 'client/src/h.ts')
    os.makedirs(os.path.dirname(fxp), exist_ok=True)
    one = {probe: [probe, 'PlanApproved']}
    rc = 0
    io.open(fxp, 'w', encoding='utf-8').write(
        "export function h(type: string) {\n  if (type === '%s') return 1;\n  return 0;\n}\n" % probe)
    per = {fxp: io.open(fxp, encoding='utf-8').read().split('\n')}
    hit = [r for r in scan_identities(per, one, set(), {probe}) if r['name'] == probe]
    fired = bool(hit) and not hit[0]['constructed'] and bool(hit[0]['read_kinds'])
    print('  夹具 %s 注入读面比较 ⇒ 报死等（不成立则"0 死等"不可信）' % ('✅' if fired else '❌'))
    io.open(fxp, 'w', encoding='utf-8').write('export const unused = 1;\n')
    per2 = {fxp: io.open(fxp, encoding='utf-8').read().split('\n')}
    gone = not any(r['read_kinds'] for r in scan_identities(per2, one, set(), {probe}) if r['name'] == probe)
    print('  撤销 %s 删掉该行 ⇒ 不再报（否则判据不成立）' % ('✅' if gone else '❌'))
    fxp3 = os.path.join(FIX, 'server/modules/x/foo.service.ts')   # 写面夹具必须在写面路径上
    os.makedirs(os.path.dirname(fxp3), exist_ok=True)
    io.open(fxp3, 'w', encoding='utf-8').write(
        "class S { async w(orgId: string) {\n  await this.db.insert(t).values({ eventCode:"
        " eventType === 'PlanApproved' ? 'PA' : 'PR' });\n  return 1;\n} }\n")
    per3 = {fxp3: io.open(fxp3, encoding='utf-8').read().split('\n')}
    r3 = [r for r in scan_identities(per3, one, set(), {probe}) if r['name'] == probe][0]
    ws = 'write-side-branch' in r3['evidence'] and not r3['read_kinds']
    print('  平面 %s 写侧"选列值"式比较归 write-side-branch、不算消费者' % ('✅' if ws else '❌'))
    import shutil
    shutil.rmtree(FIX, ignore_errors=True)
    if not (fired and gone and ws):
        rc = 1
    return rc


def main():
    global PREFIXES
    if '--self-test' in sys.argv:
        return self_test()
    chan_msg, ident, undecl = identities()
    grade = {r['channel']: r['grade'] for r in json.load(io.open(ROLES, encoding='utf-8'))['rows']}
    constructed = {c for c, g in grade.items() if g.startswith('construct')}
    per = build_corpus()
    PREFIXES = collect_prefixes(per)
    print('候选消费文件 %d 个；身份 %d 条（目录 %d + 未登记 %d）；前缀表：%s'
          % (len(per), len(ident), len(chan_msg), len(undecl), ', '.join(sorted(PREFIXES)) or '（无）'))
    rows = scan_identities(per, ident, constructed, set(chan_msg))
    read_rows = [r for r in rows if r['read_kinds']]
    dead = [r for r in read_rows if not r['constructed']]
    orphan = [r for r in rows if r['constructed'] and not r['read_kinds'] and not r['prefix_covered']]
    pref_only = [r for r in rows if r['constructed'] and not r['read_kinds'] and r['prefix_covered']]
    ws = sum(1 for r in rows if 'write-side-branch' in r['evidence'])
    print()
    print('=== 三面合账（条数由计数器给出）===')
    print('  身份 %d：有构造点 %d、无构造点 %d'
          % (len(rows), sum(1 for r in rows if r['constructed']), sum(1 for r in rows if not r['constructed'])))
    print('  读面具名消费 %d ／ 仅前缀表覆盖 %d ／ 无人按名读 %d ／ 含写侧分支 %d'
          % (len(read_rows), len(pref_only), sum(1 for r in rows if not r['read_kinds']), ws))
    print()
    print('=== 死等（读面在等、无人构造）%d 条 ===' % len(dead))
    for r in dead:
        for k in r['read_kinds']:
            for e in r['evidence'].get(k, [])[:2]:
                print('  %-28s %s:%d  %s' % (r['name'], e[0], e[1], e[2][:76]))
    print()
    print('=== 读面具名消费全清单（逐条人工核）%d 条 ===' % len(read_rows))
    for r in sorted(read_rows, key=lambda x: x['name']):
        ev = [e for k in r['read_kinds'] for e in r['evidence'].get(k, [])][:2]
        print('  %-28s 构=%s  %s' % (r['name'], 'Y' if r['constructed'] else 'N',
                                     '; '.join('%s:%d' % (e[0].split('/')[-1], e[1]) for e in ev)))
    print()
    print('=== 发了没人按名接（也不在前缀表里）%d 条（列前 24）===' % len(orphan))
    for r in sorted(orphan, key=lambda x: x['name'])[:24]:
        print('  %-28s' % r['name'])
    print('  仅被前缀表覆盖 %d 条 ⇒ 目录改名/删项不会让它变红（EVT-03 已记）' % len(pref_only))
    json.dump({'rows': rows, 'dead_wait': [r['name'] for r in dead], 'orphan': [r['name'] for r in orphan],
               'prefix_only': [r['name'] for r in pref_only], 'read_named': len(read_rows),
               'write_side_branch': ws, 'prefixes': sorted(PREFIXES)},
              io.open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('机器可读：tmp/event-readside.json')
    return 0


if __name__ == '__main__':
    sys.exit(main())
