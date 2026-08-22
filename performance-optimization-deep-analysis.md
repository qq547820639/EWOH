# EWOH 性能优化深度分析报告

---

## 一、分析概览

| 项目 | 内容 |
|------|------|
| **分析目标** | dashboard/overview 和 world/state 性能优化 |
| **当前状态** | rc40 已部署，Promise.all 优化已生效 |
| **问题** | dashboard 850ms（目标200ms），world/state 1,148ms（目标300ms） |

---

## 二、根因分析

### 2.1 dashboard/overview 性能瓶颈

**已确认状态**：
- ✅ Promise.all 并行查询已部署（代码第85行）
- ✅ 数据库查询本身很快（0.7ms）
- ❌ 端到端响应仍然慢（850ms）

**根因分析**：

| 瓶颈 | 影响 | 说明 |
|------|------|------|
| 连接池限制 | 高 | DB_POOL_MAX=10，并发请求可能等待连接 |
| ORM开销 | 中 | Drizzle ORM 查询构建和结果解析 |
| RLS策略评估 | 中 | 每次查询需评估租户隔离策略 |
| 网络延迟 | 低 | 容器到数据库网络延迟 |
| GUC设置 | 低 | 每次请求需设置PostgreSQL会话变量 |

**关键发现**：
1. Promise.all 优化已部署，但性能未达预期
2. 数据库查询本身很快（0.7ms），瓶颈在应用层
3. 连接池大小（10）可能不足以支撑高并发
4. 每次请求需设置 GUC 和评估 RLS，增加开销

### 2.2 world/state 性能瓶颈

**根因**：
- 查询所有人员/设备/工位/事件，数据量大
- 未分页，返回全量数据
- 未缓存，每次请求都查询数据库

---

## 三、优化方案

### 3.1 方案一：增加连接池大小（推荐）

**变更**：
```yaml
# docker-compose.yml
environment:
  DB_POOL_MAX: 20  # 从10增加到20
```

**预期效果**：减少连接等待时间，dashboard 降至 500ms

**风险**：增加数据库连接数，需确认数据库支持

### 3.2 方案二：添加短期缓存（推荐）

**变更**：
```typescript
// dashboard.service.ts
private overviewCache: { data: OverviewStats; timestamp: number } | null = null;
private readonly CACHE_TTL_MS = 5000; // 5秒缓存

async getOverview(actor?: OrgContext): Promise<OverviewStats> {
  const now = Date.now();
  if (this.overviewCache && now - this.overviewCache.timestamp < this.CACHE_TTL_MS) {
    return this.overviewCache.data;
  }
  // ... 原查询逻辑 ...
  this.overviewCache = { data: result, timestamp: now };
  return result;
}
```

**预期效果**：dashboard 降至 100ms（缓存命中时）

**风险**：数据延迟5秒，适合仪表板场景

### 3.3 方案三：合并查询（进阶）

**变更**：
```sql
SELECT
  (SELECT count(*) FROM ewoh_device WHERE org_id = $1) as device_total,
  (SELECT count(*) FROM ewoh_device WHERE org_id = $1 AND online = true) as device_online,
  (SELECT count(*) FROM ewoh_event WHERE org_id = $1 AND status = 'open') as event_open,
  (SELECT count(*) FROM ewoh_event WHERE org_id = $1 AND severity IN ('critical','high','medium')) as event_critical
```

**预期效果**：dashboard 降至 200ms（单次查询）

**风险**：SQL 复杂度增加，需测试性能

### 3.4 方案四：world/state 分页+缓存

**变更**：
```typescript
// 添加分页参数
async getWorldState(page = 1, pageSize = 50, actor?: OrgContext) {
  // 分页查询
  // 添加5秒缓存
}
```

**预期效果**：world/state 降至 300ms

**风险**：前端需适配分页

---

## 四、推荐实施顺序

| 优先级 | 方案 | 预期效果 | 实施难度 |
|--------|------|----------|----------|
| 1 | 增加连接池 | 500ms | 低 |
| 2 | 添加缓存 | 100ms | 低 |
| 3 | world/state分页 | 300ms | 中 |
| 4 | 合并查询 | 200ms | 高 |

---

## 五、实施建议

### 5.1 立即实施（低风险）

1. **增加连接池**：DB_POOL_MAX 从10增加到20
2. **添加缓存**：dashboard 5秒缓存

### 5.2 短期实施（1周内）

1. **world/state分页**：添加分页参数
2. **world/state缓存**：添加3秒缓存

### 5.3 中期实施（1个月内）

1. **合并查询**：将4个查询合并为1个SQL
2. **添加索引**：优化查询性能

---

## 六、验证方法

### 6.1 性能测试

```bash
# 测试dashboard
for i in $(seq 1 10); do
  curl -s -o /dev/null -w "%{time_total}" -H "Authorization: Bearer $TOKEN" \
    "http://121.43.230.202:3000/api/dashboard/overview"
done
```

### 6.2 回归测试

- 核心链路冒烟测试
- 数据一致性验证
- 功能回归测试

---

## 七、结论

**当前状态**：Promise.all 优化已部署，但性能未达预期

**根因**：连接池限制 + ORM开销 + RLS评估

**推荐方案**：
1. 增加连接池（20）
2. 添加5秒缓存
3. world/state 分页+缓存

**预期效果**：dashboard 降至 100ms，world/state 降至 300ms

---

*分析团队：性能优化工程师*
*分析时间：2026-08-23*
*分析方法：代码审查 + 性能测量 + 根因分析*
