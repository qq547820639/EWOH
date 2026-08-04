import type { SiteReadinessProbeResult, BackendProbeResult } from './siteReadinessProbe';
import type { SiteReadinessSummary } from '../api/work';
import type {
  SiteReadinessCheck,
  SiteReadinessStageDef,
  SiteReadinessStageId,
} from './siteReadinessFlow';
import type { SiteReadinessMappingConfig, ImportPreview } from './siteReadinessMapping';
import type { SiteReadinessTask, SiteReadinessApproval } from './siteReadinessTasks';

/**
 * UX-005 可审计验收包 / 交接包 / 未决项清单导出。
 *
 * 汇总当前阶段状态、映射、检查、证据、任务、签署记录为 JSON 与 Markdown，
 * 供下载归档。全部为本地生成的可审计快照。
 */

export interface SiteReadinessExportState {
  generatedAt: string;
  stages: SiteReadinessStageDef[];
  backendChecks: Record<SiteReadinessStageId, SiteReadinessCheck[]>;
  backendReports: SiteReadinessSummary[];
  probe: SiteReadinessProbeResult | null;
  backendReachable: BackendProbeResult | null;
  mapping: SiteReadinessMappingConfig;
  importPreview: ImportPreview | null;
  tasks: SiteReadinessTask[];
  approval: SiteReadinessApproval;
}

export function buildAcceptancePackage(state: SiteReadinessExportState): Record<string, unknown> {
  const stageProgress = state.stages.map((stage) => {
    const backend = state.backendChecks[stage.id] ?? [];
    const probed = state.probe?.checks.filter((c) => c.id.startsWith(stage.id)) ?? [];
    const all = [...backend, ...probed, ...stage.staticChecks];
    const passed = all.filter((c) => c.passed).length;
    return {
      stage: stage.id,
      title: stage.title,
      checks: all.map((c) => ({
        id: c.id,
        label: c.label,
        passed: c.passed,
        status: c.status,
        source: c.source,
        note: c.note,
      })),
      metrics: { total: all.length, passed },
    };
  });

  return {
    schema: 'ewoh.site-readiness.acceptance.v1',
    generatedAt: state.generatedAt,
    stages: stageProgress,
    backendReports: state.backendReports.map((r) => ({
      sourcePath: r.sourcePath,
      example: r.example,
      factoryName: r.factoryName,
      ready: r.ready,
      requiredCount: r.requiredCount,
      requiredPassed: r.requiredPassed,
      error: r.error,
    })),
    probe: state.probe
      ? {
          online: state.probe.online,
          indexedDb: state.probe.indexedDb,
          webgl: state.probe.webgl,
          vibration: state.probe.vibration,
          barcodeDetector: state.probe.barcodeDetector,
          cameraCapture: state.probe.cameraCapture,
          runsAt: state.probe.runsAt,
        }
      : null,
    backendReachable: state.backendReachable,
    mapping: state.mapping,
    importPreview: state.importPreview
      ? {
          recordCount: state.importPreview.recordCount,
          changedCount: state.importPreview.changedCount,
          error: state.importPreview.error,
        }
      : null,
    tasks: state.tasks,
    approval: state.approval,
    signature: {
      note: '本地签署记录，需现场正式签署确认',
    },
  };
}

export function buildAcceptanceMarkdown(state: SiteReadinessExportState): string {
  const lines: string[] = [];
  lines.push('# Site Readiness 验收包');
  lines.push('');
  lines.push(`- 生成时间：${state.generatedAt}`);
  lines.push(`- 后端连通：${state.backendReachable ? (state.backendReachable.reachable ? '是' : '否') : '未探测'}`);
  lines.push('');
  lines.push('## 阶段进度');
  lines.push('');
  lines.push('| 阶段 | 标题 | 通过/总数 |');
  lines.push('| --- | --- | --- |');
  for (const stage of state.stages) {
    const backend = state.backendChecks[stage.id] ?? [];
    const probed = state.probe?.checks.filter((c) => c.id.startsWith(stage.id)) ?? [];
    const all = [...backend, ...probed, ...stage.staticChecks];
    const passed = all.filter((c) => c.passed).length;
    lines.push(`| ${stage.id} | ${stage.title} | ${passed}/${all.length} |`);
  }
  lines.push('');
  lines.push('## 映射配置');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(state.mapping.rules, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## 未结决策项');
  lines.push('');
  lines.push(`- 培训完成：${state.approval.trainingComplete ? '是' : '否'}`);
  lines.push(`- 生产批准：${state.approval.productionApproved ? '是' : '否'}`);
  lines.push(`- 业务签署：${state.approval.businessSigner || '未签署'}（本地记录，需现场正式签署）`);
  lines.push('');
  lines.push('## 证据任务');
  lines.push('');
  if (state.tasks.length === 0) {
    lines.push('（无）');
  } else {
    lines.push('| 阶段 | 证据项 | 责任人 | 截止时间 | 状态 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const task of state.tasks) {
      lines.push(`| ${task.stageId} | ${task.label} | ${task.owner || '—'} | ${task.deadline || '—'} | ${task.status} |`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

export function buildPendingItemsMarkdown(tasks: SiteReadinessTask[]): string {
  const lines: string[] = [];
  lines.push('# Site Readiness 未决项清单');
  lines.push('');
  lines.push(`- 生成时间：${new Date().toISOString()}`);
  lines.push('');
  const open = tasks.filter((t) => t.status === 'open');
  if (open.length === 0) {
    lines.push('（暂无未决项）');
    return lines.join('\n');
  }
  lines.push('| 阶段 | 证据项 | 责任人 | 截止时间 |');
  lines.push('| --- | --- | --- | --- |');
  for (const task of open) {
    lines.push(`| ${task.stageId} | ${task.label} | ${task.owner || '—'} | ${task.deadline || '—'} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/** 触发浏览器下载文本文件。 */
export function downloadTextFile(filename: string, text: string, mime = 'text/plain'): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}