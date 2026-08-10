/* Task 8 / 8.1：CommandMap 入口（薄壳）。
 *
 * 原 ~1304 行的编排实现已分解至 CommandMapShell（编排壳）+ MapViewport（地图视口）
 * + 各 Workspace 组件（调度/回放/冲突/对比/决策/智能工作台）；本文件仅保留
 * 与 router import 站点（client/src/app.tsx、lib/routePrefetch.ts）一致的默认导出形状。
 */
import React from 'react';
import CommandMapShell from './CommandMapShell';

const CommandMap = (): React.ReactElement => <CommandMapShell />;

export default CommandMap;
