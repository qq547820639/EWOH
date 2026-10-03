/**
 * 时间展示的区域设置（locale）常量——前端单一事实源。
 *
 * ## 为什么是常量而不是包装函数
 * 形如
 * ```ts
 * new Date(x).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
 * ```
 * 的调用在 client/src 下有 50 余处，它们**重复的是同一批配置对象**，
 * 而不是一个可复用的逻辑。这些配置散落在两类地方：
 * - 内联字面量（约 40 处）
 * - 15 个各自实现、名字各异的本地函数（`formatTime` / `formatShortTime` /
 *   `formatBeijingTime` / `formatTimestamp` …，实为同一件事的重复实现）
 *
 * 重复的本质是**配置**（产品级决策：单厂区、固定上海时区、24 小时制），
 * 不是 `toLocaleString` 调用本身——后者是 ECMAScript 标准 API，不该被包装
 * 成项目自定义函数（那会把类型推断、Intl 扩展性与 tree-shaking 都让渡给
 * 一层无谓封装）。故收敛对象是配置，调用点保持原生形态：
 *
 * ```ts
 * import { DISPLAY_TIME_OPTS } from '@/lib/intl';
 * new Date(x).toLocaleString('zh-CN', DISPLAY_TIME_OPTS)
 * ```
 *
 * ## 为什么值得收敛
 * 这是**产品级决策**而非各处的偶然写法。分散书写的代价：
 * 改时区或改制式要动 50 处，极易漏改导致同一系统内不同时区并存；
 * 且无法全局验证一致性。集中为常量后，这三项决策有了唯一可查位置。
 *
 * ## 两套配置的差异是刻意的
 * - {@link DISPLAY_TIME_OPTS}：**完整**日期时间（年/月/日/时/分）。
 * - {@link DISPLAY_TIME_OPTS_MONTH_DAY}：仅**月/日/时/分**——列表与面板的
 *   密集时间戳用它，避免同一列里"有的显示年份有的不显示"。
 *   两者输出不同，**不可互换**；改其一不影响另一。
 *
 * ## ⚠️ 不可用于数值格式化
 * 仓库中另有 21 处形如 `x.toLocaleString('zh-CN')`（**无 options**），
 * 接收者是 number（千分位），不是 Date——那是**数值**格式化，
 * 与本文件无关，禁止混用。判据：是否需要 `Asia/Shanghai` 时区与 24 小时制。
 */

/**
 * 时间展示的区域设置：中文 + 上海时区 + 24 小时制（完整日期时间）。
 *
 * 可直接传给 `Date.prototype.toLocaleString` / `toLocaleTimeString` /
 * `toLocaleDateString`。已用 `as const` 保留字面量类型并避免每次调用重新分配。
 */
export const DISPLAY_TIME_OPTS = {
  timeZone: 'Asia/Shanghai',
  hour12: false,
} as const;

/**
 * 时间展示的区域设置：中文 + 上海时区 + 24 小时制，**仅月/日/时/分**。
 *
 * 与 {@link DISPLAY_TIME_OPTS} 的唯一区别是不显示年份——用于列表、
 * 面板等密集时间戳场景（同一列内保持显示粒度一致）。
 */
export const DISPLAY_TIME_OPTS_MONTH_DAY = {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
} as const;
