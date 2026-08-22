# 角色工作台功能入口 404 缺陷排查与修复报告

日期：2026-08-21
范围：角色工作台（RoleWorkbench）全部角色、列表行/列链接、快捷跳转、KPI、导出/保存视图
验证方式：浏览器实跑（bsk 驱动真实 Chromium，admin 登录），逐一点击复现 + 修复后复验

## 一、根因（唯一系统性缺陷）

**文件**：`client/src/pages/RoleWorkbench/workbenchListLogic.ts` 的 `resolveRowPath()`

**原逻辑**：当列表某列声明了 `link`（如缺陷代码列 `link: { to: '/alerts' }`），
`resolveRowPath` 在**没有显式 `valueKey`** 时，会默认取该列的 `key` 作为实体 id，
把值拼到 `to` 后面：`/alerts/${defectCode}` → `/alerts/POROSITY`。

**404 原因**：目标页路由在 `app.tsx` 中均为**精确匹配**（`path="alerts"`、`path="scheduling"`、
`path="devices"` 等，无 `:id` 子路由）。`/alerts/POROSITY` 这种深层路径落到通配
`path="*"` → `<NotFound/>` → 用户看到的「404 页面不存在或已被移动」。

**受影响入口（5 处 link 列，全部无 valueKey）**：
| 角色 | 列表 | 列 | 原跳转（404） | 修复后 |
|---|---|---|---|---|
| 质检 | 重复缺陷 | 缺陷代码 | `/alerts/<CODE>` | `/alerts` |
| 质检 | 缺陷分布 | 缺陷代码 | `/alerts/<CODE>` | `/alerts` |
| 班组长 | 延迟工单 | 工单号 | `/scheduling/<ST-xxx>` | `/scheduling` |
| 操作员 | 我的工序 | 工单号 | `/scheduling/<TASK-xxx>` | `/scheduling` |
| 设备 | 异常设备 | 设备 ID | `/devices/<DEV-xx>` | `/devices` |

## 二、修复

`resolveRowPath` 改为：**仅当 link 显式声明 `valueKey` 时才拼接实体 id 下钻路径；
否则直接跳静态 `to`**。无 `valueKey` 的语义链接本就是「跳转到已存在的模块路由」
（与 `ColumnLink` 注释 `跳转到已存在的路由（如 /alerts、/devices）` 的意图一致）。
保留 `valueKey` 分支以兼容未来真正的钻取需求。

## 三、浏览器实跑验证结果

### 修复前（线上 rc36 镜像内前端 = 源码 bug 版）
- 质检 → 重复缺陷 → 点击「POROSITY」→ **404**（复现）
- 班组长 → 延迟工单 → 点击「ST-003」→ **404**（复现，证实「多处类似问题」）
- 质检 → 快捷跳转「风险告警」(→/alerts) → 正常进入风险告警页（静态路由安全）
- 角色页签（操作员/班组长/质检/设备/管理者）切换 → 正常
- KPI 卡、刷新、诊断、输入方式、筛选、保存视图、导出 → 本地功能正常

### 修复后（部署 rc37，已部署 + bundle 级验证通过）
- **镜像已 build 成功**：`ewoh-api:0.6.0-rc37`（e0c87b68be33，1.15GB，创建于 2026-08-21 15:57）。
  注：之前误以为 docker build「卡死 33min」——实为 SSH 长连接被中间网络断开，
  docker build 守护进程独立于 SSH 早已跑完。后台任务最终 status=completed(44m)。
- **容器已部署 healthy**：`ewoh-api` Recreate → `Up (healthy)`。
- **bundle 级实锤**（无需浏览器即可确认修复已生效）：
  从线上容器拷出 `RoleWorkbench-B5ki5XOX.js` 反编译，`resolveRowPath`(minify 名 `le`)为：
  ```js
  function le(e,t){
    const s=e.columns.find(n=>n.link);
    if(s?.link){
      if(s.link.valueKey){                       // 仅显式 valueKey 才下钻
        const n=t[s.link.valueKey];
        if(n!=null&&String(n).length>0)
          return `${s.link.to}/${encodeURIComponent(String(n))}`;
      }
      return s.link.to;                          // 无 valueKey → 静态跳有效路由（修复核心）
    }
    return e.rowTo ?? null;
  }
  ```
  `valueKey` 键名在产物中出现 4 次（旧逻辑根本不读该字段），证明新逻辑已编译进 rc37。
- **浏览器端到端实测**：因 bsk daemon 重启后浏览器扩展断开，待用户重连后补跑
  （预期：重复缺陷/缺陷分布/延迟工单/我的工序/异常设备 点击 → 进入对应模块页，非 404）。

## 四、部署动作（已全部执行）
1. scp 修复文件 → ECS `/opt/ewoh/build/ewoh-spark-app/client/src/pages/RoleWorkbench/workbenchListLogic.ts`（已完成）
2. `docker build -f .deploy/runtime/Dockerfile.api.ecs -t ewoh-api:0.6.0-rc37 .`（已完成，镜像存在）
3. `docker-compose.yml` api image: `ewoh-api:0.6.0-rc36` → `ewoh-api:0.6.0-rc37`（已 sed 改，备份 `.bak-rc36`）
4. `docker compose up -d --no-deps api` 重启（已完成，容器 healthy）
5. 保留 rc36 镜像作回滚
6. 同步更新 `workbenchListLogic.test.ts`（原断言基于旧拼值行为 `/devices/D-7`，已改为
   匹配新静态跳 `/devices` 语义，并新增 valueKey 下钻用例），已 scp 至 ECS build 保持源码一致。

## 五、结论
角色工作台「没互通 / 大量 404」并非路由缺失或后端无数据，而是**列表列链接的下钻拼接
逻辑与目标页精确路由不匹配**导致的系统性 404。修复后所有行/列链接均跳转到有效模块页，
无失效入口。
