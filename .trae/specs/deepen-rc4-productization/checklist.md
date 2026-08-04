# Checklist
## W1：只读审计与事实一致性
- [ ] 《RC4 权威事实差异报告》`docs/reviews/RC4_AUTHORITATIVE_FACTS_GAP.md` 已产出，且大规模改码前完成只读审计
- [ ] README/CHANGELOG/release-manifest/state/task-board/phase-state/gates 版本一致性检查完成
- [ ] OpenAPI 路由数/数据库表数/Work Graph 节点数/场景包清单一致性检查完成
- [ ] 每份证据完整性检查（commitSha/branch/command/suite/environment/startedAt/completedAt/result/artifactChecksum/verifier/expiresAt）完成
- [ ] repository-facts schema 已建立；事实采集与一致性 CLI 已实现；冲突返回非零退出码
- [ ] rc3/rc4 CHANGELOG 与 release notes 已补齐；测试证据统计口径已统一
- [ ] task-board/phase-state/gates/Next Waves 陈旧状态已清理；检查已接入 CI 与 release gate
- [ ] 每项自动修复输出可审查 Diff，未静默覆盖源文件

## W2：视觉资源链修复与产品级设计系统
- [x] 视觉资源链根因已诊断修复（Tailwind/CSS、静态资源路径、CSP、截图时机、tree-shaking）
- [x] 视觉质量门禁已建立（资源 404/console error/未处理异常阻断测试）
- [x] 统一 design token（spacing/typography/radius/elevation/status/focus/motion）已建立
- [x] 统一组件（AppShell/Sidebar/Topbar/Button/Input/Select/Table/Card/Badge/Tabs/Drawer/Dialog/Toast/Skeleton/EmptyState/ErrorState/PermissionState/OfflineState）已实现
- [x] 多视口视觉回归已运行；关键页面基准截图已生成
- [x] axe 无障碍检查已引入，无 serious/critical 问题；键盘焦点清晰；状态不只用颜色表达；表单错误在字段附近
- [x] 所有页面已实现 loading/empty/error/offline/permission-denied 状态

## W3：因果执行控制台 UX 深化
- [ ] 默认首页已回答当前 Gate/阻塞任务/最长等待/过期证据/待人类决策风险/下一最优行动/过载项
- [ ] 响应式侧边导航 + 命令面板；全局搜索、保存视图、最近访问、URL 深链接；预设视图实现
- [ ] DAG 平移缩放/聚焦关键路径/阶段折叠/渐进加载/节点搜索/上下游追踪/异常回流高亮/布局保存
- [ ] 图节点可访问列表替代视图；证据抽屉（commit/PR/测试命令/环境/日志/截图/校验和/验证人/有效期）
- [ ] 批量 Gate 操作先显示影响范围；高风险操作支持条件批准/驳回/撤销/回滚点
- [ ] Agent 页/资源页实现；键盘快捷键（不绕过审批）；性能基准建立

## W4：真实 GitHub Issue/PR/CI 同步闭环
- [ ] 权限探测/dry-run/人类批准后 apply；WorkItem↔Issue 稳定映射；完整追踪链
- [ ] 幂等与重复提交保护；部分成功补偿续传；API 限流退避；外部修改 reconciliation；冲突处理
- [ ] 同步状态机实现（planned/approval_required/applying/partially_applied/synced/conflicted/failed/retrying）
- [ ] 为权限不足/仓库保护/PR 冲突/CI 失败/网络中断编写 E2E
- [ ] 未获真实授权不登记为 live sync passed；保留离线文件模式

## W5：移动工作台重构
- [ ] MobileWorkbench 已拆分为指定独立领域模块；页面组件不直接承载全部领域状态；状态分层清晰
- [ ] 扫码优先/任务优先；单手操作；触控目标 ≥44×44；自动带入上下文
- [ ] 离线同步中心完整状态显示；失败记录可操作；冲突界面可解释
- [ ] 照片压缩上传/进度/重试/断点续传；权限拒绝替代输入；PWA 更新不中断未同步
- [ ] 边界条件 E2E 已完成；关键页面手机截图已生成；操作步骤与时间已优化

## W6：工厂上线与复制体验
- [ ] F0-F6 分阶段进度；环境预检实现；阻塞项显示责任人/修复命令/重测
- [ ] Profile/映射预览；dry-run；人类批准；安全回滚；每步自动生成证据
- [ ] 自动计算实施指标；真实工厂证据不存在显示「尚未验证」；未用模拟证据冒充真实工厂
- [ ] 向导界面产品化；用户可逐阶段验证

## W7：生产质量与持续观测
- [ ] Docker/K8s/Helm 验证；安装/升级/灰度/回滚/迁移演练；备份恢复/RPO/RTO 测量
- [ ] 稳定性与压力测试；边界网络/时钟测试；SBOM/依赖/镜像/密钥安全
- [ ] OTel 统一 trace；关键产品指标已采集；不采集不必要敏感数据
- [ ] 独立验证 Agent 复核全部 Done 定义；差距报告已产出
- [ ] 最终交付物（差距报告/依赖图/代码迁移/测试证据/截图/生产手册/真实工厂待办/独立验证报告/更新 artifacts）齐全
- [ ] 每波次都通过所有验收门禁（lint/typecheck/unit/contract/OpenAPI/PostgreSQL/HTTP E2E/Playwright/visual/accessibility/security/repository-facts/release-manifest）

## 最终完成定义
- [ ] 所有新增代码有测试；活跃 API 无 500；OpenAPI 与实际路由一致
- [ ] 生产构建 CSS/静态资源正常加载；关键桌面/移动流程有稳定截图
- [ ] 无 serious/critical 无障碍问题；所有证据绑定 commit SHA 与环境
- [ ] task-board/phase-state/gates/CHANGELOG/release manifest 一致
- [ ] 实现 Agent 未自行验证高风险任务；外部条件未满足时 Pilot Readiness 保持 NOT READY
- [ ] 结论从 A–E 五档选一，附可验证证据：A=核心完成但不具备生产/规模复制；B=核心完成具备受控试点；C=第二真实工厂无分叉复制；D=第三真实工厂配置化复制；E=伙伴交付 Scale Ready 1.0