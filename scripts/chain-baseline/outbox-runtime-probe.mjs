import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 投递日志（ewoh_outbox）运行期探针（V141）。静态清点说"无消费确认、无保留"，本探针把它变成读数：
 * 一次链级运行落了哪些行、status 是否还全是 pending、published_at 是否仍为空、老行是否被裁过、
 * 以及游标空洞落在谁身上（订阅者视角按 org 分区重算跳号率）。
 *
 * 用法（需先 `make chain-baseline-up`，一般再 `-seed`）：
 *   make chain-baseline-outbox-probe                # 全表读数
 *   make chain-baseline-outbox-probe SINCE=6098     # 只看该游标之后（=本次运行产生）的行
 * "本次运行的行"用生产自己的单调 sequence 选，不用墙钟窗口（V75 的教训：时间窗口会把别的运行算进来）。
 * 凭据走环境变量，与 schema-probe.mjs 同一入口；本脚本不打印连接串。集群未起时退出码 3（与 doctor 同语义）。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const req = createRequire(path.join(root, 'ewoh-spark-app/package.json'));
const postgres = req('postgres');

const env = (name, fallback) => (process.env[name] || '').trim() || fallback;
const url = `postgresql://${env('EWOH_CHAIN_BASE_OWNER', 'ewoh_owner')}:${env(
  'EWOH_CHAIN_BASE_OWNER_PW',
  'ewoh_chain_pw',
)}@127.0.0.1:${env('EWOH_CHAIN_BASE_PORT', '55432')}/${env('EWOH_CHAIN_BASE_DB', 'ewoh')}`;
const since = Number(process.env.SINCE || process.argv[2] || 0);

const sql = postgres(url, { max: 1 });
const q = async (text, vals = []) => (await sql.unsafe(text, vals))[0] ?? {};
const qa = async (text, vals = []) => (await sql.unsafe(text, vals)) ?? [];

try {
  const win = since > 0 ? `where sequence > ${since}` : '';
  const out = {
    since,
    table_total: await q(
      `select count(*)::int as rows, min(sequence) as min_seq, max(sequence) as max_seq,
              min(created_at) as oldest, max(created_at) as newest from ewoh_outbox`,
    ),
    run_window: await q(
      `select count(*)::int as rows,
              count(*) filter (where status <> 'pending') as not_pending,
              count(*) filter (where published_at is not null) as published_at_set
         from ewoh_outbox ${win}`,
    ),
    status_dist: await qa(
      `select status, count(*)::int as n from ewoh_outbox ${win} group by status order by n desc`,
    ),
    hole_stats: await q(
      `with d as (select sequence, sequence - lag(sequence) over (order by sequence) as jump
         from ewoh_outbox)
       select count(*) filter (where jump > 1)::int as gap_deliveries,
              count(*) filter (where jump = 1)::int as contiguous_deliveries,
              max(jump)::bigint as max_jump,
              (select last_value from ewoh_outbox_sequence_seq)::bigint as seq_last_value,
              (select max(sequence) from ewoh_outbox)::bigint as landed_max
         from d`,
    ),
    per_subscriber_view: await qa(
      `with d as (select coalesce(org_id,'<null>') as org,
                        sequence - lag(sequence) over (partition by coalesce(org_id,'<null>') order by sequence) as jump
                   from ewoh_outbox)
       select org, count(*)::int as rows,
              count(*) filter (where jump > 1)::int as gap_deliveries,
              count(*) filter (where jump = 1)::int as contiguous_deliveries,
              max(jump)::bigint as max_jump
         from d group by org order by rows desc limit 6`,
    ),
  };
  out.age_seconds =
    out.table_total.oldest && out.table_total.newest
      ? Math.round(
          (new Date(out.table_total.newest).getTime() - new Date(out.table_total.oldest).getTime()) /
            1000,
        )
      : null;
  console.log(JSON.stringify(out, null, 2));
  await sql.end({ timeout: 1 });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/connect|ECONNREFUSED|does not exist|no route/i.test(msg)) {
    console.log(`[outbox-probe] 连不上基线库：${msg}`);
    console.log('[outbox-probe] 先 `make chain-baseline-up`（必要时 -seed）；退出码 3=环境不可用，不是探针判红');
    process.exit(3);
  }
  console.error('[outbox-probe] 探针失败：', msg);
  process.exit(1);
}
