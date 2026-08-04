import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Play,
  Download,
  FileText,
  Map,
  Cpu,
  Workflow,
  CheckCircle2,
  Circle,
  ClipboardCheck,
  TriangleAlert,
  Signpost,
  RotateCcw,
} from 'lucide-react';
import type { SiteReadinessSummary } from '../../api/work';
import {
  SITE_READINESS_STAGES,
  clusterChecksByStage,
  BACKEND_INFRA_ITEMS,
  type SiteReadinessCheck,
  type SiteReadinessStageId,
} from '../../lib/siteReadinessFlow';
import {
  runSiteReadinessProbe,
  probeBackendConnectivity,
  repairSuggestionsForProbe,
  type SiteReadinessProbeResult,
  type BackendProbeResult,
} from '../../lib/siteReadinessProbe';
import {
  DEFAULT_MAPPING_RULES,
  runMappingDryRun,
  buildImportPreview,
  loadMappingConfig,
  saveMappingConfig,
  loadImportPreview,
  saveImportPreview,
  type MappingRule,
  type SiteReadinessMappingConfig,
  type DryRunResult,
  type ImportPreview,
} from '../../lib/siteReadinessMapping';
import {
  registerTask,
  updateTask,
  loadTasks,
  saveTasks,
  openTasks,
  tasksForStage,
  loadApproval,
  saveApproval,
  signBusiness,
  type SiteReadinessTask,
  type SiteReadinessApproval,
} from '../../lib/siteReadinessTasks';
import { runBackendMappingDryRun } from '../../lib/siteReadinessBackend';
import {
  buildAcceptancePackage,
  buildAcceptanceMarkdown,
  buildPendingItemsMarkdown,
  downloadTextFile,
  type SiteReadinessExportState,
} from '../../lib/siteReadinessExport';
import { StatusBadge } from './shared';

const DEFAULT_SAMPLE = JSON.stringify(
  { order_no: 'SO-1001', device_no: 'DEV-42', org: 'acme', id: 'u-7' },
  null,
  2,
);

const inputClass =
  'h-9 w-full rounded-lg border border-[hsl(220_14%_89%)] bg-white px-3 text-sm outline-none focus:border-blue-500';

const SectionCard = ({
  icon: Icon,
  title,
  badge,
  children,
}: {
  icon: typeof Play;
  title: string;
  badge?: string;
  children: React.ReactNode;
}): React.ReactElement => (
  <section className="rounded-lg border border-[hsl(220_14%_89%)] bg-white">
    <div className="flex flex-wrap items-center gap-2 border-b border-[hsl(220_14%_89%)] px-5 py-3">
      <Icon className="h-4 w-4 text-blue-600" />
      <h3 className="font-semibold text-[hsl(220_14%_14%)]">{title}</h3>
      {badge && (
        <span className="ml-auto rounded-md bg-[hsl(220_14%_96%)] px-2 py-0.5 text-xs text-[hsl(218_10%_42%)]">
          {badge}
        </span>
      )}
    </div>
    <div className="p-5">{children}</div>
  </section>
);

const CheckRow = ({ check }: { check: SiteReadinessCheck }): React.ReactElement => (
  <div className="flex items-start gap-2 py-1.5">
    {check.passed ? (
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
    ) : (
      <Circle className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(218_10%_42%)]" />
    )}
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-2 text-sm text-[hsl(220_14%_14%)]">
        <span>{check.label}</span>
        <StatusBadge status={check.status} />
        <span className="text-xs text-[hsl(218_10%_42%)]">
          {check.source === 'backend'
            ? '后端报告'
            : check.source === 'probe'
              ? '环境探测'
              : '占位'}
        </span>
      </div>
      {check.note && <p className="mt-0.5 text-xs text-[hsl(218_10%_42%)]">{check.note}</p>}
    </div>
  </div>
);

const SiteReadinessWizard = ({
  reports,
}: {
  reports: SiteReadinessSummary[];
}): React.ReactElement => {
  const [activeStage, setActiveStage] = useState<SiteReadinessStageId>('F0');
  const [probe, setProbe] = useState<SiteReadinessProbeResult | null>(null);
  const [backendReachable, setBackendReachable] = useState<BackendProbeResult | null>(null);
  const [probing, setProbing] = useState(false);

  const [mapping, setMapping] = useState<SiteReadinessMappingConfig>(() => loadMappingConfig());
  const [importText, setImportText] = useState('');
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(() =>
    loadImportPreview(),
  );

  const [dryRunSample, setDryRunSample] = useState(DEFAULT_SAMPLE);
  const [dryRunMappingId, setDryRunMappingId] = useState('');
  const [dryRun, setDryRun] = useState<DryRunResult | null>(null);
  const [dryRunError, setDryRunError] = useState<string | null>(null);

  const [tasks, setTasks] = useState<SiteReadinessTask[]>(() => loadTasks());
  const [approval, setApproval] = useState<SiteReadinessApproval>(() => loadApproval());
  const [newEvidence, setNewEvidence] = useState('');

  const backendChecks = useMemo(
    () => clusterChecksByStage(reports.flatMap((r) => r.checks ?? [])),
    [reports],
  );

  const persistTasks = (next: SiteReadinessTask[]) => {
    setTasks(next);
    saveTasks(next);
  };

  const persistMapping = (next: SiteReadinessMappingConfig) => {
    setMapping(next);
    saveMappingConfig(next);
  };

  const runProbe = async () => {
    setProbing(true);
    const result = runSiteReadinessProbe();
    const reachable = await probeBackendConnectivity();
    setProbe(result);
    setBackendReachable(reachable);
    setProbing(false);
    toast.success('环境探测完成');
  };

  const stageDef = SITE_READINESS_STAGES.find((s) => s.id === activeStage)!;
  const stageBackend = backendChecks[activeStage];
  const stageChecks = [...stageBackend, ...stageDef.staticChecks];
  const stageTasks = tasksForStage(tasks, activeStage);
  const suggestions = probe ? repairSuggestionsForProbe(probe) : [];
  const stageSuggestions = suggestions.filter((s) => s.stageId === activeStage);

  const registerEvidence = () => {
    const label = newEvidence.trim();
    if (!label) {
      toast.error('请填写缺失证据项');
      return;
    }
    persistTasks(
      registerTask(tasks, {
        stageId: activeStage,
        evidenceId: label,
        label,
        owner: '',
        deadline: '',
        status: 'open',
      }),
    );
    setNewEvidence('');
    toast.success('已登记缺失证据');
  };

  const updateMappingRule = (index: number, patch: Partial<MappingRule>) => {
    const rules = mapping.rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule));
    persistMapping({ ...mapping, rules, updatedAt: new Date().toISOString() });
  };

  const runLocalDryRun = () => {
    const parsed = parseSample(dryRunSample);
    if (!parsed) {
      toast.error('示例数据 JSON 解析失败');
      return;
    }
    setDryRun(runMappingDryRun(parsed, mapping.rules));
    setDryRunError(null);
  };

  const runBackendDryRun = async () => {
    const id = dryRunMappingId.trim();
    if (!id) {
      toast.error('请填写后端映射 ID');
      return;
    }
    const parsed = parseSample(dryRunSample);
    if (!parsed) {
      toast.error('示例数据 JSON 解析失败');
      return;
    }
    try {
      const result = await runBackendMappingDryRun(id, parsed);
      setDryRun(result as DryRunResult);
      setDryRunError(null);
      toast.success('后端 Dry Run 完成');
    } catch (error) {
      setDryRun(null);
      setDryRunError(
        error instanceof Error ? error.message : '后端 Dry Run 失败',
      );
      toast.error('后端 Dry Run 失败，请检查映射 ID 或后端是否已注册该映射');
    }
  };

  const generatePreview = () => {
    const preview = buildImportPreview(importText, mapping.rules);
    setImportPreview(preview);
    saveImportPreview(preview);
    if (preview.error) {
      toast.error(preview.error);
    } else {
      toast.success('已生成导入差异预览（本地预览）');
    }
  };

  const buildExportState = (): SiteReadinessExportState => ({
    generatedAt: new Date().toISOString(),
    stages: SITE_READINESS_STAGES,
    backendChecks,
    backendReports: reports,
    probe,
    backendReachable,
    mapping,
    importPreview,
    tasks,
    approval,
  });

  const exportAcceptance = () => {
    const state = buildExportState();
    downloadTextFile(
      'site-readiness-acceptance.json',
      JSON.stringify(buildAcceptancePackage(state), null, 2),
      'application/json',
    );
    downloadTextFile('site-readiness-acceptance.md', buildAcceptanceMarkdown(state), 'text/markdown');
    toast.success('验收包已导出');
  };

  const exportPending = () => {
    downloadTextFile(
      'site-readiness-pending.md',
      buildPendingItemsMarkdown(openTasks(tasks)),
      'text/markdown',
    );
    toast.success('未决项清单已导出');
  };

  const setApprovalField = (patch: Partial<SiteReadinessApproval>) => {
    const next = { ...approval, ...patch, updatedAt: new Date().toISOString() };
    setApproval(next);
    saveApproval(next);
  };

  const doSign = () => {
    const signer = approval.businessSigner.trim();
    if (!signer) {
      toast.error('请填写签署人');
      return;
    }
    const next = signBusiness(approval, signer);
    setApproval(next);
    saveApproval(next);
    toast.success('已生成本地签署记录（需现场正式签署）');
  };

  return (
    <div className="space-y-5">
      {/* 头部 */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[hsl(220_14%_89%)] bg-white px-5 py-4">
        <ClipboardCheck className="h-4 w-4 text-emerald-600" />
        <h2 className="font-semibold text-[hsl(220_14%_14%)]">Site Readiness 实施向导</h2>
        <span className="ml-auto flex flex-wrap gap-2">
          <button
            type="button"
            onClick={exportPending}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[hsl(220_14%_89%)] bg-white px-3 py-2 text-sm font-medium text-[hsl(220_14%_14%)] hover:bg-[hsl(220_14%_96%)]"
          >
            <FileText className="h-4 w-4" />
            导出未决项清单
          </button>
          <button
            type="button"
            onClick={exportAcceptance}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            <Download className="h-4 w-4" />
            导出验收包
          </button>
        </span>
      </div>

      {/* F0-F6 Stepper */}
      <div className="rounded-lg border border-[hsl(220_14%_89%)] bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          {SITE_READINESS_STAGES.map((stage) => {
            const bc = backendChecks[stage.id];
            const passed = [...bc, ...stage.staticChecks].filter((c) => c.passed).length;
            const total = [...bc, ...stage.staticChecks].length;
            const active = stage.id === activeStage;
            return (
              <button
                key={stage.id}
                type="button"
                onClick={() => setActiveStage(stage.id)}
                className={`flex min-w-[120px] flex-col gap-1 rounded-lg border px-3 py-2 text-left transition-colors ${
                  active
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-[hsl(220_14%_89%)] bg-white hover:bg-[hsl(220_14%_96%)]'
                }`}
              >
                <span className="text-xs font-semibold text-[hsl(218_10%_42%)]">
                  {stage.id} · {stage.title}
                </span>
                <span className="text-xs text-[hsl(218_10%_42%)]">
                  {passed}/{total} 通过
                </span>
              </button>
            );
          })}
        </div>

        {/* 当前阶段详情 */}
        <div className="mt-4 rounded-lg bg-[hsl(220_14%_96%)] p-4">
          <div className="flex items-center gap-2">
            <Signpost className="h-4 w-4 text-blue-600" />
            <span className="text-sm font-semibold text-[hsl(220_14%_14%)]">
              {stageDef.id} · {stageDef.title}
            </span>
            <span className="text-xs text-[hsl(218_10%_42%)]">{stageDef.subtitle}</span>
          </div>
          <p className="mt-1 text-sm text-[hsl(218_10%_42%)]">{stageDef.description}</p>
          <div className="mt-3 space-y-0.5">
            {stageChecks.map((check) => (
              <CheckRow key={`${activeStage}-${check.id}`} check={check} />
            ))}
          </div>
          {stageSuggestions.length > 0 && (
            <div className="mt-3 space-y-1 rounded-md bg-amber-50 p-3">
              {stageSuggestions.map((s) => (
                <p key={s.id} className="flex items-start gap-2 text-xs text-amber-800">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {s.message}
                </p>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 环境/工具自动探测 */}
      <SectionCard icon={Cpu} title="环境 / 工具自动探测" badge="客户端可探测">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={runProbe}
            disabled={probing}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            <Play className="h-4 w-4" />
            {probing ? '探测中…' : '运行环境探测'}
          </button>
          {backendReachable && (
            <span className="text-xs text-[hsl(218_10%_42%)]">
              后端连通：{backendReachable.reachable ? '是' : '否'}
              {backendReachable.latencyMs !== undefined
                ? ` · ${backendReachable.latencyMs}ms`
                : ''}
              {backendReachable.error ? ` · ${backendReachable.error}` : ''}
            </span>
          )}
        </div>
        {probe && (
          <div className="mt-3 grid gap-1 sm:grid-cols-2">
            {probe.checks.map((check) => (
              <CheckRow key={check.id} check={check} />
            ))}
          </div>
        )}
        <p className="mt-3 text-xs text-[hsl(218_10%_42%)]">
          TODO(后端)：Docker / K8s / Helm / 对象存储 / 真实设备探测属后端与现场能力，本向导不伪造结果。
        </p>
      </SectionCard>

      {/* 基础设施检查 */}
      <SectionCard icon={Workflow} title="基础设施检查（DB / K8s / Helm / 对象存储 / 真实设备）" badge="后端/现场待接入">
        <div className="space-y-1">
          {BACKEND_INFRA_ITEMS.map((item) => (
            <div key={item.id} className="flex items-start gap-2 py-1">
              <Circle className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(218_10%_42%)]" />
              <div>
                <p className="text-sm text-[hsl(220_14%_14%)]">{item.label}</p>
                <p className="text-xs text-[hsl(218_10%_42%)]">{item.note}</p>
              </div>
            </div>
          ))}
        </div>
      </SectionCard>

      {/* ERP/设备/组织/身份映射 (F3) */}
      <SectionCard icon={Map} title="ERP / 设备 / 组织 / 身份映射向导" badge="F3 · 保存到本地">
        <div className="space-y-2">
          {mapping.rules.map((rule, index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_130px_auto]">
              <input
                value={rule.from}
                onChange={(e) => updateMappingRule(index, { from: e.target.value })}
                placeholder="源字段"
                className={inputClass}
              />
              <input
                value={rule.to}
                onChange={(e) => updateMappingRule(index, { to: e.target.value })}
                placeholder="目标字段"
                className={inputClass}
              />
              <input
                value={rule.transform ?? ''}
                onChange={(e) =>
                  updateMappingRule(index, { transform: e.target.value || undefined })
                }
                placeholder="transform"
                className={inputClass}
              />
              <label className="flex items-center gap-1.5 text-sm text-[hsl(220_14%_14%)]">
                <input
                  type="checkbox"
                  checked={Boolean(rule.required)}
                  onChange={(e) => updateMappingRule(index, { required: e.target.checked })}
                />
                必填
              </label>
            </div>
          ))}
          <p className="text-xs text-[hsl(218_10%_42%)]">
            映射已保存到 localStorage（key:
            ewoh.siteReadiness.mapping.v1）。字段变换支持 trim/upper/lower/number/string/default。
          </p>
        </div>
      </SectionCard>

      {/* Mapping Dry Run (F4) */}
      <SectionCard icon={Play} title="Mapping Dry Run" badge="F4 · 验证">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs text-[hsl(218_10%_42%)]">示例数据（JSON）</span>
            <textarea
              value={dryRunSample}
              onChange={(e) => setDryRunSample(e.target.value)}
              rows={4}
              className="mt-1 w-full rounded-lg border border-[hsl(220_14%_89%)] bg-white p-3 font-mono text-xs outline-none focus:border-blue-500"
            />
          </label>
          <div className="space-y-2">
            <label className="block">
              <span className="text-xs text-[hsl(218_10%_42%)]">后端映射 ID（可选）</span>
              <input
                value={dryRunMappingId}
                onChange={(e) => setDryRunMappingId(e.target.value)}
                placeholder="如 template-xxx"
                className={`${inputClass} mt-1`}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={runLocalDryRun}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                本地示例 Dry Run
              </button>
              <button
                type="button"
                onClick={runBackendDryRun}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[hsl(220_14%_89%)] bg-white px-3 py-2 text-sm font-medium text-[hsl(220_14%_14%)] hover:bg-[hsl(220_14%_96%)]"
              >
                <RotateCcw className="h-4 w-4" />
                后端 Dry Run
              </button>
            </div>
            <p className="text-xs text-[hsl(218_10%_42%)]">
              调用 POST /api/scale/mappings/:id/dry-run。本地示例为非真实映射，仅供演示。
            </p>
          </div>
        </div>
        {dryRunError && (
          <div className="mt-3 rounded-md bg-red-50 p-3 text-xs text-red-700">
            {dryRunError}。TODO(后端)：如需向导内直接 dry-run，后端需提供按规则集执行的接口。
          </div>
        )}
        {dryRun && (
          <div className="mt-3 rounded-md border border-[hsl(220_14%_89%)] p-3">
            <div className="flex items-center gap-2 text-sm">
              {dryRun.passed ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              ) : (
                <TriangleAlert className="h-4 w-4 text-amber-500" />
              )}
              <span className="font-medium text-[hsl(220_14%_14%)]">
                {dryRun.passed ? 'Dry Run 通过' : 'Dry Run 未通过'}
              </span>
              <span className="text-xs text-[hsl(218_10%_42%)]">
                {dryRun.ruleCount} 条规则 · {dryRun.errors.length} 个错误
              </span>
            </div>
            {dryRun.errors.length > 0 && (
              <ul className="mt-2 space-y-1">
                {dryRun.errors.map((err, i) => (
                  <li key={i} className="text-xs text-red-600">
                    [{err.code}] {err.sourceField} → {err.targetField}: {err.message}
                  </li>
                ))}
              </ul>
            )}
            <pre className="mt-2 overflow-x-auto rounded-md bg-[hsl(220_14%_96%)] p-2 text-xs">
              {JSON.stringify(dryRun.mapped, null, 2)}
            </pre>
          </div>
        )}
      </SectionCard>

      {/* 导入前后差异预览 (F3/F4) */}
      <SectionCard icon={FileText} title="导入前后差异预览" badge="本地预览">
        <textarea
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          placeholder={'粘贴待导入数据（JSON 对象或数组），例如：\n[{"order_no":"SO-1","device_no":"D-1"}]'}
          rows={4}
          className="w-full rounded-lg border border-[hsl(220_14%_89%)] bg-white p-3 font-mono text-xs outline-none focus:border-blue-500"
        />
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={generatePreview}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            <Play className="h-4 w-4" />
            生成差异预览
          </button>
          <span className="text-xs text-[hsl(218_10%_42%)]">
            对比字段映射前后，存入 localStorage（ewoh.siteReadiness.importPreview.v1）。
          </span>
        </div>
        {importPreview && (
          <div className="mt-3">
            {importPreview.error ? (
              <p className="rounded-md bg-red-50 p-3 text-xs text-red-700">{importPreview.error}</p>
            ) : (
              <>
                <p className="text-xs text-[hsl(218_10%_42%)]">
                  {importPreview.recordCount} 条记录 · {importPreview.changedCount} 条发生变化
                </p>
                <div className="mt-2 max-h-72 overflow-auto rounded-md border border-[hsl(220_14%_89%)]">
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 border-b border-[hsl(220_14%_89%)] bg-[hsl(220_14%_96%)]">
                      <tr>
                        <th className="px-3 py-2 font-medium">#</th>
                        <th className="px-3 py-2 font-medium">导入前</th>
                        <th className="px-3 py-2 font-medium">导入后</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[hsl(220_14%_89%)]">
                      {importPreview.rows.map((row) => (
                        <tr key={row.index}>
                          <td className="px-3 py-2 text-[hsl(218_10%_42%)]">{row.index + 1}</td>
                          <td className="px-3 py-2 font-mono">{JSON.stringify(row.before)}</td>
                          <td className="px-3 py-2 font-mono">
                            {row.changed ? (
                              <span className="text-emerald-700">{JSON.stringify(row.after)}</span>
                            ) : (
                              <span className="text-[hsl(218_10%_42%)]">{JSON.stringify(row.after)}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}
      </SectionCard>

      {/* 缺失证据 / 责任人 / 截止时间 */}
      <SectionCard icon={ClipboardCheck} title="缺失证据与责任人" badge={`${openTasks(tasks).length} 项未结`}>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={newEvidence}
            onChange={(e) => setNewEvidence(e.target.value)}
            placeholder={`为 ${activeStage} 登记缺失证据项`}
            className={`${inputClass} max-w-sm`}
          />
          <button
            type="button"
            onClick={registerEvidence}
            className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            登记
          </button>
        </div>
        <div className="mt-3 space-y-2">
          {stageTasks.length === 0 && (
            <p className="text-xs text-[hsl(218_10%_42%)]">当前阶段暂无待办项。</p>
          )}
          {stageTasks.map((task) => (
            <div key={task.id} className="grid gap-2 rounded-md border border-[hsl(220_14%_89%)] p-3 sm:grid-cols-[1fr_140px_150px_auto]">
              <div>
                <p className="text-sm text-[hsl(220_14%_14%)]">{task.label}</p>
                <p className="text-xs text-[hsl(218_10%_42%)]">{task.stageId}</p>
              </div>
              <input
                value={task.owner}
                onChange={(e) =>
                  persistTasks(updateTask(tasks, task.id, { owner: e.target.value }))
                }
                placeholder="责任人"
                className={inputClass}
              />
              <input
                type="date"
                value={task.deadline}
                onChange={(e) =>
                  persistTasks(updateTask(tasks, task.id, { deadline: e.target.value }))
                }
                className={inputClass}
              />
              <button
                type="button"
                onClick={() =>
                  persistTasks(
                    updateTask(tasks, task.id, {
                      status: task.status === 'open' ? 'done' : 'open',
                    }),
                  )
                }
                className={`rounded-lg px-3 py-2 text-sm font-medium ${
                  task.status === 'done'
                    ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                    : 'border border-[hsl(220_14%_89%)] bg-white text-[hsl(220_14%_14%)] hover:bg-[hsl(220_14%_96%)]'
                }`}
              >
                {task.status === 'done' ? '已完成' : '未完成'}
              </button>
            </div>
          ))}
        </div>
      </SectionCard>

      {/* 培训 / 生产批准 / 业务签署 (F5) */}
      <SectionCard icon={Signpost} title="培训 / 生产批准 / 业务签署" badge="F5 · 本地记录">
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm text-[hsl(220_14%_14%)]">
            <input
              type="checkbox"
              checked={approval.trainingComplete}
              onChange={(e) => setApprovalField({ trainingComplete: e.target.checked })}
            />
            培训完成
          </label>
          <label className="flex items-center gap-2 text-sm text-[hsl(220_14%_14%)]">
            <input
              type="checkbox"
              checked={approval.productionApproved}
              onChange={(e) => setApprovalField({ productionApproved: e.target.checked })}
            />
            生产批准已确认
          </label>
          <div className="flex flex-wrap items-end gap-2">
            <label className="block">
              <span className="text-xs text-[hsl(218_10%_42%)]">业务签署人</span>
              <input
                value={approval.businessSigner}
                onChange={(e) => setApprovalField({ businessSigner: e.target.value })}
                placeholder="签署人姓名"
                className={`${inputClass} mt-1`}
              />
            </label>
            <button
              type="button"
              onClick={doSign}
              className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              签署
            </button>
          </div>
          {approval.signedAt && (
            <p className="text-xs text-[hsl(218_10%_42%)]">
              已签署：{approval.businessSigner} · {new Date(approval.signedAt).toLocaleString('zh-CN', { hour12: false })}
              （本地签署记录，需现场正式签署）
            </p>
          )}
        </div>
      </SectionCard>
    </div>
  );
};

/** 解析 dry-run 示例 JSON 为对象；失败返回 null。 */
function parseSample(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export default SiteReadinessWizard;