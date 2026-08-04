import type { SiteReadinessSummary } from '../api/work';

/**
 * UX-005 Site Readiness 实施向导 —— F0-F6 流程定义与检查项归类。
 *
 * 说明：后端尚未提供按阶段(Stage)分组的检查项契约，因此这里
 * 1) 定义七个阶段的静态占位检查项（source='static'，标注"待真实数据/待现场"）；
 * 2) 提供关键字归类函数，把后端 site-readiness 报告里的 checks 尽量映射到阶段；
 * 3) 提供环境探测结果的修复建议文案。
 *
 * 真实环境探测（Docker/K8s/Helm/真实设备）属后端/现场能力，列为 TODO，
 * 不在客户端伪造返回值。
 */

export type SiteReadinessStageId = 'F0' | 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6';

export type CheckSource = 'backend' | 'static' | 'probe';

export interface SiteReadinessCheck {
  id: string;
  label: string;
  passed: boolean;
  status: string;
  source: CheckSource;
  note?: string;
}

export interface SiteReadinessStageDef {
  id: SiteReadinessStageId;
  title: string;
  subtitle: string;
  description: string;
  /** 该阶段真实后端检查项（source='backend'）应展示的占位检查。 */
  staticChecks: SiteReadinessCheck[];
}

const staticCheck = (
  id: string,
  label: string,
  note: string,
  status = 'pending',
): SiteReadinessCheck => ({
  id,
  label,
  passed: false,
  status,
  source: 'static',
  note,
});

export const SITE_READINESS_STAGES: SiteReadinessStageDef[] = [
  {
    id: 'F0',
    title: '环境准备',
    subtitle: 'Environment prep',
    description:
      '确认目标工厂/场地的基础环境：服务器、云资源、网络与命名空间规划是否就绪。',
    staticChecks: [
      staticCheck('F0.server', '服务器/云资源规划通过', '待现场确认'),
      staticCheck('F0.namespace', '生产命名空间已创建', '待现场确认'),
      staticCheck('F0.network', '网络与域名解析就绪', '待现场确认'),
    ],
  },
  {
    id: 'F1',
    title: '工具与依赖',
    subtitle: 'Tools & deps',
    description:
      '确认部署与运行所需工具链：容器运行时、Kubernetes 集群、Helm 与依赖版本。',
    staticChecks: [
      staticCheck('F1.docker', 'Docker / 容器运行时可用', '待现场确认'),
      staticCheck('F1.k8s', 'Kubernetes 集群可用', '待现场确认'),
      staticCheck('F1.helm', 'Helm 已安装且版本匹配', '待现场确认'),
      staticCheck('F1.deps', '依赖版本满足要求', '待现场确认'),
    ],
  },
  {
    id: 'F2',
    title: '连接与数据',
    subtitle: 'Connectivity & data',
    description:
      '确认与目标系统的连接：ERP、数据库、对象存储以及数据源凭据是否就绪。',
    staticChecks: [
      staticCheck('F2.erp', 'ERP 系统连通', '待现场确认'),
      staticCheck('F2.db', '数据库连接可用', '待现场确认'),
      staticCheck('F2.storage', '对象存储可用', '待现场确认'),
      staticCheck('F2.creds', '数据源凭据就绪', '待现场确认'),
    ],
  },
  {
    id: 'F3',
    title: '映射与导入',
    subtitle: 'Mapping & import',
    description:
      '定义 ERP/设备/组织/身份字段映射，规划导入批次与数据校验规则。',
    staticChecks: [
      staticCheck('F3.mapping', '字段映射完成', '依赖本地映射表，待真实数据'),
      staticCheck('F3.batch', '导入批次规划完成', '待真实数据'),
      staticCheck('F3.validation', '数据校验规则就绪', '待真实数据'),
    ],
  },
  {
    id: 'F4',
    title: '验证与试运行',
    subtitle: 'Validation & dry-run',
    description: '执行 Mapping Dry Run 与导入差异预览，验证关键路径与校验规则。',
    staticChecks: [
      staticCheck('F4.dryrun', 'Mapping Dry Run 通过', '依赖后端 dry-run 接口，待真实数据'),
      staticCheck('F4.diff', '导入差异预览已确认', '本地预览，待现场确认'),
      staticCheck('F4.path', '关键路径验证通过', '待现场确认'),
    ],
  },
  {
    id: 'F5',
    title: '培训与批准',
    subtitle: 'Training & approval',
    description:
      '完成操作员培训、获取生产批准与业务签署，作为上线的准入条件。',
    staticChecks: [
      staticCheck('F5.training', '操作员培训完成', '待现场确认'),
      staticCheck('F5.approval', '生产批准已确认', '待现场确认'),
      staticCheck('F5.signoff', '业务签署完成', '本地签署记录，需现场正式签署'),
    ],
  },
  {
    id: 'F6',
    title: '上线与交接',
    subtitle: 'Go-live & handover',
    description: '确认上线窗口、交接记录与回滚应急预案，完成可审计交接包。',
    staticChecks: [
      staticCheck('F6.window', '上线窗口确认', '待现场确认'),
      staticCheck('F6.handover', '交接记录完整', '待现场确认'),
      staticCheck('F6.rollback', '回滚应急预案就绪', '待现场确认'),
    ],
  },
];

export const SITE_READINESS_STAGE_BY_ID: Readonly<Record<SiteReadinessStageId, SiteReadinessStageDef>> =
  Object.fromEntries(SITE_READINESS_STAGES.map((s) => [s.id, s])) as Record<
    SiteReadinessStageId,
    SiteReadinessStageDef
  >;

/** 阶段关键字，用于把后端检查项归类到对应阶段（大小写不敏感）。 */
const STAGE_KEYWORDS: Record<SiteReadinessStageId, string[]> = {
  F0: ['env', 'environment', 'prepare', '环境', '准备', '网络', 'domain', 'namespace'],
  F1: ['tool', 'docker', 'kube', 'k8s', 'helm', '依赖', '工具', 'runtime', 'container'],
  F2: ['connect', 'erp', 'database', 'db ', 'storage', 's3', '连接', '数据', 'object', 'credential'],
  F3: ['mapping', 'import', '映射', '导入', 'transform', 'batch'],
  F4: ['valid', 'dry', 'test', '验证', '试运行', 'preview', 'check'],
  F5: ['train', 'approve', 'sign', '培训', '批准', '签署'],
  F6: ['go', 'launch', 'handover', '上线', '交接', 'rollback', 'handoff'],
};

/** 把单个检查项归类到阶段；无法归类返回 null。 */
export function classifyStage(check: { id: string; label: string }): SiteReadinessStageId | null {
  const haystack = `${check.id} ${check.label}`.toLowerCase();
  for (const stage of SITE_READINESS_STAGES) {
    if (STAGE_KEYWORDS[stage.id].some((kw) => haystack.includes(kw))) {
      return stage.id;
    }
  }
  return null;
}

/**
 * 把后端报告中的 checks 按阶段聚簇。归类不了的检查项归入 F4（验证）之前的
 * 兜底阶段，或保留在 "unclassified" 集合中返回。
 */
export function clusterChecksByStage(
  checks: SiteReadinessSummary['checks'],
): Record<SiteReadinessStageId, SiteReadinessCheck[]> {
  const result: Record<SiteReadinessStageId, SiteReadinessCheck[]> = {
    F0: [],
    F1: [],
    F2: [],
    F3: [],
    F4: [],
    F5: [],
    F6: [],
  };
  for (const check of checks ?? []) {
    const stage = classifyStage(check);
    const bucket = stage ?? 'F4';
    result[bucket].push({
      id: check.id,
      label: check.label,
      passed: check.passed,
      status: check.status,
      source: 'backend',
    });
  }
  return result;
}

/** 修复建议：针对环境探测结果给出提示文案（仅提示，不自动执行任何修改）。 */
export interface RepairSuggestion {
  id: string;
  stageId: SiteReadinessStageId;
  message: string;
}

export const BACKEND_INFRA_ITEMS: Array<{
  id: string;
  label: string;
  note: string;
}> = [
  { id: 'infra.db', label: '数据库（PostgreSQL）健康', note: '由后端 /health/ready 提供，待现场确认' },
  { id: 'infra.k8s', label: 'Kubernetes 集群', note: '后端/现场能力，dashboard 待接入' },
  { id: 'infra.helm', label: 'Helm 部署', note: '后端/现场能力，暂以占位展示' },
  { id: 'infra.storage', label: '对象存储（S3）', note: '后端/现场能力，暂以占位展示' },
  { id: 'infra.device', label: '真实设备（扫码枪/摄像头/PLC）', note: '需要真实设备，现场验证' },
];