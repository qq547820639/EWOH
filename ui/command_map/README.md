# ARCHIVED / 已归档 — 非生产代码，仅作历史 UX 原型参考。

> **警告：本目录已被归档。请勿在未阅读并遵守以下约定前修改本目录下的任何文件。**

## 说明

本目录是 EWOH 早期阶段的**静态 UX 原型**（纯 HTML/CSS/JS），仅用于历史交互设计与视觉效果参考。**它不是生产事实源（source of truth）**，禁止在本目录中实现任何新的生产功能。

## 生产事实源

- **生产 Command Map（前端）**：`ewoh-spark-app/client/src/pages/CommandMap/`（React + React Query + SSE）
- **生产调度 authority（后端）**：NestJS `ewoh-spark-app/server/modules/scheduler/`
- **Python Edge**：`src/edge_platform/scheduler/` 仅为 **advisory / degraded** 参考，不构成生产调度 authority。

## 目录内容（仅供参考）

| 路径 | 用途 |
| --- | --- |
| `admin/` | 早期管理面板原型（CSS/JS） |
| `assets/` | 原型公共资源（样式、脚本） |
| `layers/` | 地图图层交互原型 |
| `map/` | 工厂地图渲染原型 |
| `timeline/` | 时间线视图原型 |
| `workbench/` | 工作台视图原型 |
| `index.html` | 原型入口页面 |

以上内容均仅为 UX 参考，不参与生产运行。

## 约定

1. 任何新的调度 / 地图功能必须落在生产代码路径（见上文"生产事实源"），**不得**在本目录实现。
2. 如确需参考本目录内容，请在相关代码或文档中明确标注"仅供参考"，并对照生产事实源验证。
3. 本目录的任何修改都应有明确理由（如历史归档维护），默认不接受新增生产逻辑。

---

归档日期：2026-08-10
