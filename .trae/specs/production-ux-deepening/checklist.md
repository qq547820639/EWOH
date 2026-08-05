# Checklist

## W1：审计与环境基线
- [ ] 执行环境与仓库指纹已记录（HEAD/branch/时间/OS/Node/Python/DB/容器/依赖版本）
- [ ] 只读交叉核对 README/CHANGELOG/release/openapi/contracts/catalog/tools/apps/output/.codex 完成
- [ ] work-console 全部 Review/Validation/Pending/Proposed/Refining 项与证据元数据缺口已盘点
- [ ] 生成物本机绝对路径已盘点（如 work-console.json sourceRoot）
- [ ] 可运行门禁基线已运行并记录结果

## W2：状态与证据收口
- [ ] 状态仅依据当前 HEAD 代码+测试+有效证据判定 Done；否则按 Code Implemented/Code Verified/Runtime Verified/Pilot Ready/Production Ready 分级
- [ ] 证据元数据已补充/刷新（commitSha/branch/buildVersion/envFingerprint/dependencyVersion/testTime/verifier/expiresAt）
- [ ] 生成物本机绝对路径已清除（改仓库相对/脱敏路径）
- [ ] work-console/gate-decisions/work-graph/task-board/phase-state/Next Waves 已同步

## W3：发布与仓库一致性
- [ ] RC4 发布材料版本/证据版本/描述一致；根版本/Helm/Compose/K8s/运行时/发布目录/CHANGELOG/前端版本统一
- [ ] ewoh-spark-app/package.json 模板名称与版本残留已修复，单一版本事实源建立
- [ ] ewoh-spark-app/README.md 已编写（架构/环境/启动/测试/真实 PostgreSQL/浏览器测试/故障/安全边界）
- [ ] 未路由页面/Placeholder/Example/遗留目录/重复封装/无引用代码已审计（删除或说明用途）
- [ ] 生产 fail-closed 无 stub 回退；开发 stub 有醒目标记

## W4：OpenAPI 契约自动化
- [ ] gen:openapi 已替换 UNSUPPORTED, SKIP；基于 OpenAPI 生成 TS 类型与客户端
- [ ] 客户端不重复手写契约已有类型；已接入现有 API 封装
- [ ] CI 有生成物无漂移校验
- [ ] 错误/分页/取消/幂等键/附件/离线同步契约类型测试已补
- [ ] 未改变既有公开 API 行为（或提供兼容层/迁移说明/回归测试）

## W5：统一页面状态与错误恢复
- [ ] 统一页面状态系统已实现并有测试（Skeleton/局部刷新/空数据/失败/部分失败/无权限/离线/陈旧/后台同步/冲突/会话过期/降级）
- [ ] 路由加载非全屏「加载中…」；布局前后不明显跳动；查询失败不渲染为「没有数据」
- [ ] 陈旧数据保留并显示时间/状态；errorCode/requestId/retryable/recommendedAction 统一错误界面；可复制 requestId；明确已保存/可重试/下一步
- [ ] 范围化重试实现（当前/失败项/全部），避免重复提交成功操作
- [ ] 主要页面有单元测试与浏览器测试

## W6：PWA 与离线队列
- [ ] 较大离线数据与照片迁移到 IndexedDB+Blob
- [ ] schema version/迁移/容量/配额/压缩/加密/过期/损坏恢复机制实现
- [ ] 断点续传/分块上传；queued/syncing/synced/failed/conflict/discarded 状态及更新时间
- [ ] 单项失败不阻塞其他；冲突不自动覆盖服务端，支持对比/重试/放弃/人工解决
- [ ] 关闭/崩溃/重启/升级后未同步数据恢复
- [ ] SW 缓存版本/更新提示/旧版清理/安全回滚
- [ ] 断网/弱网/抖动/重复提交/上传中断/令牌过期/配额不足/升级测试完成

## W7：角色驱动 + 可信度 + 无障碍
- [ ] 角色首页「当前最需要处理的事项」优先；任务含原因/优先级/截止/影响/责任人/下一步
- [ ] 跨实体跳转；全局搜索/命令面板遵守组织隔离与角色权限
- [ ] 危险操作影响预览与二次确认；高频安全操作减少确认但保留状态机与幂等；键盘/扫码/触摸/单手优化
- [ ] 数据可信度组件已扩展到指挥中心/地图/世界状态回放/AI/排产/设备/告警/质检/报表/导出
- [ ] Playwright 多项目矩阵（Chromium/Firefox/WebKit）与桌面/手机/平板/触摸/低性能/弱网/重连/长跑覆盖
- [ ] 键盘/焦点/ARIA/对比度/200% 缩放/减少动画；触控目标适手套；高对比不单靠颜色；声音/震动反馈；视觉回归分基线

## W8：可观测、安全、性能与交付
- [ ] Web Vitals/路由耗时/接口失败率/同步队列耗时/冲突率/白屏/未处理异常采集；requestId/traceId 串联；运维诊断页
- [ ] 令牌/会话/多标签/离线会话审计；离线缓存与照片敏感数据保护
- [ ] CSP/安全头/上传校验/文件大小/恶意文件隔离/S3 签名 URL；性能预算；长列表分页/虚拟化
- [ ] 全部门禁运行并记录；环境缺失项标记 BLOCKED_BY_ENVIRONMENT 且给可复现命令与 CI 入口
- [ ] docs/reviews/production-ux-deepening-report.md 已产出（含四级结论）
- [ ] Work Graph/Work Console/门禁/发布清单/CHANGELOG 已更新

## 最终完成定义
- [ ] 现有能力无回归；新功能有测试；无静默 skip；无模拟通过
- [ ] 无模板品牌和版本漂移；无空 README；无开发者本机绝对路径泄漏；无生产模式 stub 回退
- [ ] 所有错误有可操作恢复路径；主要页面具备完整加载/失败/空数据/离线/权限/陈旧状态
- [ ] 离线数据可在重启和升级后可靠恢复；浏览器和设备矩阵有自动化证据
- [ ] 当前无法完成的现场和审批事项被诚实保留，未错误宣称项目 Production Ready