# -*- coding: utf-8 -*-
# 契约事件「角色」普查：目录 70 条逐条定性 + 反向未登记名（V135 建立，常驻可复算）
# 用法：make chain-baseline-event-roles
#
# 为什么不是 V133 的问法：V133 问"这个名字在非测试源码里出现过吗"，得到 emit/validate-only
# 两桶；本轮问"出现在**什么角色**里"，因为实测发现同一句"有构造点"背后混着三种东西：
#   ① 真的进了执行器（`_publish("task.created", …)`）
#   ② 只是消费/订阅（`eventType === 'X'`、`@OnEvent('X')`）
#   ③ 只是本地常量表里的一个串（Prometheus 计数器名、测试开关名）
#
# 两条已证伪的写法（本轮修掉的量具缺陷，写在这里免得下次再犯）：
#  - 子串匹配：`run.created` 的类名 `RunCreated` 是 `SimulationRunCreated` 的子串 ⇒ 假构造。
#    现在一律带词边界，并允许 `com.ewoh.` 前缀。
#  - 执行器只列种子名：`emitSse()` / `_emit_catalog_event()` 这类**本仓包装函数**体转发给
#    enqueue/publish，名字却是字面量传进去的 ⇒ 4 条 conflict.* 被误判"仅注册"。
#    现在做一轮闭包：函数体含执行器调用 ⇒ 该函数名并入执行器集。
#  - 带引号才算命中：`resource.state.changed` 只在注释散文里出现 ⇒ 会被判"零命中"（比实际强）。
#    现在散文单独一轮，注释/文档与"字面量零命中"分开报。
#
# 读数纪律：动态拼装（f-string/模板串）无法静态定性 ⇒ 单独计量为**上界**缺口，不折算比例；
# 对照未全绿 ⇒ rc=1，本轮读数不出数。
import io
import json
import re
import subprocess
import sys

Y = 'contracts/events/event-catalog.yaml'
SCAN = ['src', 'ewoh-spark-app/server', 'ewoh-spark-app/shared', 'ewoh-spark-app/client/src']
PROJ_BASES = ('event_catalog.py', 'event-catalog.ts')

SEED_ACT = re.compile(r'\b(?:enqueue|enqueueThrottled|_publish|publishEvent|publish)\s*\(')
FUNC_HEAD = re.compile(r'^\s*(?:private |public |protected |async |static |def )*(\w+)\s*\(')
NAME_ARG_RE = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:,|\)|$)")
ENV_VAL_RE = re.compile(r"""['"]?(eventType|event_type|sseType)['"]?\s*[:=]\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,)]""")
ENV_SH_RE = re.compile(r"^\s*(eventType|event_type)\s*,\s*$", re.M)   # re.M：整行简写 `eventType,`
ENV_KEY_RE = re.compile(r"""['"]?(eventType|event_type|sseType)['"]?\s*[:=]""")
BIND_RE = re.compile(r'\b(?:const|let|var)\s+(eventType|event_type)\s*=')
PERSIST_RE = re.compile(r'(insert\(\s*ewohEvent|values\(\s*\{|insert_event\(|buildEventEnvelope\()')
STR_RE = re.compile(r"""['"]([A-Za-z][A-Za-z0-9_.]{3,})['"]""")
TEST_RE = re.compile(r'(\.spec\.|\.test\.|__tests__|/tests/|test_)')
DOCS_RE = re.compile(r'\.(md|rst|txt)$')
MANIFEST_RE = re.compile(r'\.json$')
MIGRATION_RE = re.compile(r'(migrations/|\.sql$|/verify/)')
COMMENT_RE = re.compile(r'^\s*(//|\*|/\*|#)')
CONSUME_RE = re.compile(
    r'(===|!==|==|switch\s*\(|case\s+|subscribe|@OnEvent|handler|addEventListener|'
    r'onmessage|\.includes\(|indexOf\()')

GRADE_ORDER = ['construct-actuator', 'construct-envelope', 'construct-binding', 'construct-map',
               'near-actuator', 'registry', 'consume', 'comment', 'prose',
               'manifest', 'migration', 'docs', 'test', 'none']
GRADE_CN = {
    'construct-actuator': '构造·执行器实参', 'construct-envelope': '构造·信封字段',
    'construct-binding': '构造·名字绑定', 'construct-map': '构造·名字映射表',
    'near-actuator': '待人工·执行器同区域', 'registry': '仅注册/声明', 'consume': '仅消费/订阅',
    'comment': '仅注释提及', 'prose': '仅散文提及', 'manifest': '仅连接器 manifest',
    'migration': '仅迁移/校验 SQL', 'docs': '仅文档', 'test': '仅测试', 'none': '字面量零命中',
}
CONSTRUCT = [g for g in GRADE_ORDER if g.startswith('construct')]

# 已逐条读源码核对过的两跳映射表（值经 .get()/索引 落到信封字段）
MAP_TABLES = {'src/edge_platform/inference/events.py': 'EVENT_CODE_CATALOG_TYPE'}

FILES = {}


def lines_of(f):
    if f not in FILES:
        FILES[f] = io.open(f, encoding='utf-8', errors='ignore').read().split('\n')
    return FILES[f]


def kind_of(f):
    if TEST_RE.search(f):
        return 'test'
    if DOCS_RE.search(f):
        return 'docs'
    if MANIFEST_RE.search(f):
        return 'manifest'
    if MIGRATION_RE.search(f):
        return 'migration'
    return 'prod'


def sh(args):
    return subprocess.run(args, capture_output=True, text=True)


def re_escape(s):
    return re.escape(s)


def needle_res(names):
    """词边界 + 允许 com.ewoh. 前缀；点号按字面（不当通配）。"""
    pats = []
    for n in names:
        core = re_escape(n).replace('\\_', '[._]')
        pats.append(r'(?<!\w)(?:com\.ewoh\.)?%s(?!\w)' % core)
    return re.compile('|'.join(pats))


# ---------- 目录 ----------
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
    return sorted(chan_msg), chan_msg, msg_type, (
        set(chan_msg) | set(msg_type) | set(msg_type.values()))


# ---------- 执行器闭包：种子 + 「首参/信封值 = 自己的形参」的本仓包装函数 ----------
def params_of(src, i):
    """函数头可能跨行：从 `NAME(` 起读到闭合 `)`，返回形参名列表（去类型/默认值）。"""
    txt = ''
    for j in range(i, min(len(src), i + 12)):
        txt += src[j]
        if txt.count('(') > txt.count(')') and txt.count(')') == 0:
            continue
        if txt.count('(') <= txt.count(')'):
            break
    m = re.search(r'\(([^)]*)\)', txt, re.S)
    if not m:
        return []
    raw = re.sub(r'\{[^{}]*\}', '', m.group(1))     # 默认值里的对象字面量
    out = []
    for p in raw.replace('\n', ' ').split(','):
        p = p.strip()
        if not p:
            continue
        name = re.match(r'^(\w+)', p)
        if name and name.group(1) not in ('self', 'this'):
            out.append(name.group(1))
    return out


def build_actors(prod_files):
    actors, wrappers = set(), {}
    for f in prod_files:
        src = lines_of(f)
        for i, text in enumerate(src):
            m = FUNC_HEAD.match(text)
            if not m or '(' not in text:
                continue
            name = m.group(1)
            if name in ('if', 'for', 'while', 'switch', 'catch', 'return', 'def'):
                continue
            ps = params_of(src, i)
            if not ps:
                continue
            body = '\n'.join(src[i + 1:i + 45])
            # ① 种子调用的首参就是自己的形参 ⇒ 名字从入参流进来
            for sm in SEED_ACT.finditer(body):
                first = NAME_ARG_RE.match(body[sm.end():sm.end() + 60])
                if first and first.group(1) in ps:
                    wrappers[name] = first.group(1)
            # ② 信封字段 `eventType: <形参>`（含对象简写 `eventType,`）⇒ 同上
            for em in ENV_VAL_RE.finditer(body):
                if em.group(2) in ps:
                    wrappers[name] = em.group(2)
            if ENV_SH_RE.search(body) and any(p in ('eventType', 'event_type') for p in ps):                wrappers[name] = 'eventType' if 'eventType' in ps else 'event_type'
    actors.update(wrappers)
    actors.update({'enqueue', 'enqueueThrottled', '_publish', 'publishEvent', 'publish'})
    return actors, wrappers


def in_actor_call(region, names, actors):
    """名字是否落在某个执行器调用的括号内（≤240 字符窗口）。"""
    for nm in actors:
        for m in re.finditer(r'\b%s\s*\(' % re_escape(nm), region):
            window = region[m.end():m.end() + 240]
            for n in names:
                if re.search(r"['\"]%s['\"]" % re_escape(n), window):
                    return True
    return False


def classify(f, src, idx, text, kind, names, actors):
    if kind != 'prod':
        return kind
    line_no = idx + 1
    lo, hi = max(0, idx - 6), min(len(src), idx + 7)
    region = '\n'.join(src[lo:hi])
    if any(re.search(r"['\"]%s['\"]" % re_escape(n), text) for n in names) and \
            f in MAP_TABLES and re.match(r'^\s*["\'][A-Z]\w+["\']\s*:', text):
        return 'construct-map'
    if ENV_KEY_RE.search(text) and not COMMENT_RE.match(text):
        # 联合类型标注（`'A' | 'B'`）是**声明**允许值，不是构造点
        if re.search(r"['\"]\s*\|\s*['\"]", text):
            return 'registry'
        # 含 `.get(code, "Fallback")` 的回退名：命中行上有字面量即算落到信封字段
        if any(re.search(r"['\"]%s['\"]" % re_escape(n), text) for n in names):
            return 'construct-envelope'
    if in_actor_call(region, names, actors) and not COMMENT_RE.match(text):
        return 'construct-actuator'
    # 名字是 eventType 绑定初值的一部分（含多行三元），且同函数里有落库/执行器关键字
    near_bind = '\n'.join(src[max(0, idx - 4):idx + 2])
    below = '\n'.join(src[idx + 1:min(len(src), idx + 45)])
    if BIND_RE.search(near_bind) and (PERSIST_RE.search(below) or SEED_ACT.search(below)):
        return 'construct-binding'
    if COMMENT_RE.match(text):
        return 'comment'
    if CONSUME_RE.search(text):
        return 'consume'
    if SEED_ACT.search(region):
        return 'near-actuator'
    return 'registry'


def roles_for(name, msgclass, per, actors):
    names = sorted({name, name.replace('.', '_')} | ({msgclass} if msgclass else set()))
    rx = needle_res(names)
    roles = {}
    for f, rows in per.items():
        kind = kind_of(f)
        src = lines_of(f)
        for no, text in rows:
            if not rx.search(text):
                continue
            role = classify(f, src, no - 1, text, kind, names, actors)
            roles.setdefault(role, []).append((f, no, text.strip()[:150], kind))
    return roles


def prose_only(name, msgclass):
    """字面量之外还有没有散文提及（注释/文档里的裸名字）？用 git grep -F 固定串。"""
    hits = []
    for nd in sorted({name, (msgclass or name)}):
        out = sh(['git', 'grep', '-l', '-F', '-e', nd, '--'] + SCAN)
        for f in out.stdout.split():
            if f.endswith('.pyc') or f.split('/')[-1] in PROJ_BASES:
                continue
            txt = io.open(f, encoding='utf-8', errors='ignore').read().split('\n')
            for i, ln in enumerate(txt):
                if needle_res([nd]).search(ln):
                    hits.append((f, i + 1, ln.strip()[:150], kind_of(f)))
    return hits


def _load_v133():
    """V133 桶只用于交叉核对；产物不在时交叉表跳过，不影响本轮定性。"""
    try:
        return json.load(io.open('tmp/contract-emitters.json', encoding='utf-8'))['channels']
    except (OSError, ValueError):
        return {}


V133 = _load_v133()


def bucket_of(c):
    return (V133.get(c) or {}).get('bucket', '-')


def main():
    channels, chan_msg, msg_type, declared = parse_catalog()
    pat = r"['\"][a-z][a-z0-9_]*(\.[a-z][a-z0-9_]+)+['\"]|['\"][A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*['\"]"
    out = sh(['git', 'grep', '-n', '-E', pat, '--'] + SCAN)
    per = {}
    for ln in out.stdout.splitlines():
        m = re.match(r'^([^:]+):(\d+):(.*)$', ln)
        if not m:
            continue
        f, no = m.group(1), int(m.group(2))
        if f.endswith('.pyc') or f.split('/')[-1] in PROJ_BASES:
            continue
        per.setdefault(f, []).append((no, m.group(3)))
    prod_files = sorted(f for f in per if kind_of(f) == 'prod')
    actors, wrappers = build_actors(prod_files)
    print('目录：通道 %d、消息类 %d、声明身份 %d；语料文件 %d（生产 %d）；执行器集 %d 个名字'
          % (len(channels), len(msg_type), len(declared), len(per), len(prod_files), len(actors)))
    print('闭包出的包装函数 %d 个（函数体里首参/信封值 = 自己的形参）：' % len(wrappers))
    for k in sorted(wrappers):
        print('   %-26s 名字参数 %s' % (k, wrappers[k]))

    print()
    print('=== 对照 ===')
    rc = 0
    must = {'task.created': 'TaskCreated', 'assignment.dispatched': 'AssignmentDispatched',
            'plan.dispatched': 'PlanDispatched', 'device.thermal_risk': 'DeviceThermalRisk',
            'device.low_battery': 'DeviceLowBattery', 'device.state.changed': 'DeviceStateChanged',
            'conflict.acknowledged': 'ConflictAcknowledged',
            'agent.decision_recorded': 'AgentDecisionRecorded',
            'entity.state_observed': 'EntityStateObserved',
            # 已读到调用点字面量的落库型包装函数（recordEvent → insert(ewohEvent)）：
            # workorder.service.ts:196 / simulation.service.ts:153
            'workorder.completed': 'WorkOrderCompleted',
            'simulation.run_completed': 'SimulationRunCompleted'}
    for name, mc in sorted(must.items()):
        roles = roles_for(name, mc, per, actors)
        got = [g for g in CONSTRUCT if g in roles]
        if not got:
            rc = 1
        print('  正向 %-24s %s %s' % (name, '✅' if got else '❌ 量具没开火',
                                      [GRADE_CN[g] for g in got] or sorted(roles)))
    bogus = roles_for('zzz.not.declared', 'ZzzNotDeclared', per, actors)
    if bogus:
        rc = 1
    print('  负向 zzz.not.declared %s' % ('✅ 零命中' if not bogus else '❌ ' + str(list(bogus))))
    # 子串假阳性专项：`run.created` 不得因为 `SimulationRunCreated` 而算构造
    trap = roles_for('run.created', 'RunCreated', per, actors)
    if any(g.startswith('construct') for g in trap):
        rc = 1
        print('  边界 ❌ run.created 仍被 SimulationRunCreated 误伤：%s' % list(trap))
    else:
        print('  边界 ✅ run.created 未被 SimulationRunCreated 误伤（词边界生效）')

    dyn = sh(['git', 'grep', '-n', '-E',
              r"(eventType|event_type)['\"]?[[:space:]]*[:=][[:space:]]*(f['\"]|\`)", '--'] + SCAN)
    dyn_rows = [r for r in dyn.stdout.splitlines() if r and not r.endswith('.pyc')]
    print('  动态拼装事件名 %d 处（静态定性的上界缺口，不折算比例）' % len(dyn_rows))
    for r in dyn_rows[:8]:
        print('     ', r[:140])

    print()
    print('=== 70 条逐条定性 ===')
    print('%-32s %-14s %-20s %s' % ('通道', 'V133 桶', 'V135 定性', '首要证据'))
    rows = []
    for c in channels:
        mc = chan_msg.get(c)
        roles = roles_for(c, mc, per, actors)
        grade = next((g for g in GRADE_ORDER if g in roles), None)
        ev = roles.get(grade, []) if grade else []
        prose = []
        if grade is None or grade == 'none':
            grade = 'none'
            pw = [h for h in prose_only(c, mc) if h[3] == 'prod']
            if pw:
                grade = 'prose'
                ev = pw
        prod = [e for e in ev if e[3] == 'prod'] or ev
        rows.append({'channel': c, 'message': mc, 'bucket_v133': bucket_of(c), 'grade': grade,
                     'roles': {k: len(v) for k, v in roles.items()},
                     'evidence': [list(x) for x in ev[:5]]})
        print('%-32s %-14s %-20s %s' % (c, bucket_of(c), GRADE_CN[grade],
                                        '%s:%s' % (prod[0][0], prod[0][1]) if prod else '-'))

    tally = {}
    for r in rows:
        tally[r['grade']] = tally.get(r['grade'], 0) + 1
    print()
    print('定性合计（条数由计数器给出，不手抄）：')
    for g in GRADE_ORDER:
        if g in tally:
            print('  %-20s %d' % (GRADE_CN[g], tally[g]))
    constructed = sum(tally[g] for g in CONSTRUCT if g in tally)
    print('  —— 合计 %d；有构造点 %d；无构造点 %d' % (len(rows), constructed, len(rows) - constructed))

    print()
    print('=== V133 桶 ↔ V135 定性 错配 ===')
    mis = [r for r in rows if (r['bucket_v133'] == 'emit') != (r['grade'] in CONSTRUCT)]
    for r in mis:
        print('  %-30s V133=%-14s V135=%s' % (r['channel'], r['bucket_v133'], GRADE_CN[r['grade']]))
    print('  错配 %d / %d' % (len(mis), len(rows)))

    print()
    print('=== 反向：进了执行器/信封但目录没这条的名字 ===')
    undecl = {}
    for f in prod_files:
        src = lines_of(f)
        for i, text in enumerate(src):
            env = bool(ENV_KEY_RE.search(text))
            if not env and not SEED_ACT.search(text):
                continue
            # 只看**实参位**：V136 实测整窗取串会把载荷键（task_id/task_type）与错误码
            # （unknown_event_type）也算成"未登记事件名"，清单从 15 涨到 42 ⇒ 噪声吃掉信号。
            head = None
            if not env:
                m = SEED_ACT.search(text)
                head = text[m.end():] if m else ''
            pool = text if env else (head + '\n' + '\n'.join(src[i + 1:i + 3]))
            if not env:
                depth, cut = 0, len(pool)
                for j, chx in enumerate(pool):
                    if chx in '([{':
                        depth += 1
                    elif chx in ')]}':
                        if depth == 0:
                            cut = j
                            break
                        depth -= 1
                    elif chx == ',' and depth == 0:
                        cut = j
                        break
                pool = pool[:cut]
            for m in STR_RE.finditer(pool):
                s = m.group(1)
                if s in declared or len(s) < 6 or i + 1 > len(src):
                    continue
                if '.' not in s and not re.match(r'^[A-Z][a-z]', s):
                    # 边界（V136 实测后保留）：本量具只认点号名与 PascalCase。放开 snake_case 会把
                    # 载荷键/枚举值（device_status、erp_order、propose_plan、unknown_event_type…）
                    # 一并卷进来（清单 15 → 42），信号被噪声吃掉。snake_case 事件名（实测有：
                    # plan.service.ts:726 的 enqueue 首实参 'stale_plan'）由 **AST 量具**负责——
                    # `make chain-baseline-event-payload` 直接读实参位，不按名字形状猜。
                    continue
                undecl.setdefault(s, []).append('%s:%d' % (f, i + 1))
    for s in sorted(undecl):
        print('  %-34s %s' % (s, undecl[s][0]))
    print('  未登记名字 %d 个（逐个待人工定性：真漏登记 / 同名近邻 / 内部键）' % len(undecl))

    io.open('tmp/event-roles.json', 'w', encoding='utf-8').write(json.dumps(
        {'rows': rows, 'tally': tally, 'constructed': constructed, 'mismatch': len(mis),
         'undeclared': {k: v[:3] for k, v in undecl.items()}, 'actors': sorted(actors),
         'dynamic_sites': len(dyn_rows), 'controls_rc': rc}, ensure_ascii=False, indent=1))
    print('机器可读：tmp/event-roles.json')
    if rc:
        print('❌ 对照未全绿 ⇒ 本轮读数作废')
    return rc


if __name__ == '__main__':
    sys.exit(main())
