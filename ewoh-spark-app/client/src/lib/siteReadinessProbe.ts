import type { SiteReadinessCheck, RepairSuggestion } from './siteReadinessFlow';

/**
 * UX-005 环境/工具自动探测 —— 仅在客户端可探项目才做真实探测。
 *
 * 可探测项：
 * - 网络在线状态（navigator.onLine）
 * - IndexedDB 可用性
 * - WebGL（复用 webgl.ts）
 * - 振动 API
 * - 条形码检测 API（BarcodeDetector）
 * - 摄像头捕获（navigator.mediaDevices.getUserMedia）
 * - 后端连通性（/health/live，public 接口）
 *
 * 真实环境探测（Docker/K8s/Helm/真实设备）属后端/现场能力，列为 TODO，
 * 不在客户端伪造返回值。
 */

export interface SiteReadinessProbeResult {
  checks: SiteReadinessCheck[];
  online: boolean;
  indexedDb: boolean;
  webgl: boolean;
  vibration: boolean;
  barcodeDetector: boolean;
  cameraCapture: boolean;
  runsAt: string;
}

function hasWebGL(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    return Boolean(
      canvas.getContext('webgl2') ||
        canvas.getContext('webgl') ||
        canvas.getContext('experimental-webgl'),
    );
  } catch {
    return false;
  }
}

function hasIndexedDb(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(window.indexedDB);
}

function hasVibration(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

function isOnline(): boolean {
  if (typeof navigator === 'undefined') return true;
  // Node 等环境可能定义了 navigator 但没有 onLine，此时视为在线。
  return navigator.onLine !== false;
}

const probeCheck = (
  id: string,
  label: string,
  passed: boolean,
  note: string,
): SiteReadinessCheck => ({
  id,
  label,
  passed,
  status: passed ? 'passed' : 'failed',
  source: 'probe',
  note,
});

/** 运行浏览器能力探测（同步，无副作用）。 */
export function runSiteReadinessProbe(): SiteReadinessProbeResult {
  const online = isOnline();
  const indexedDb = hasIndexedDb();
  const webgl = hasWebGL();
  const vibration = hasVibration();
  const barcodeDetector = typeof BarcodeDetector !== 'undefined';
  const cameraCapture =
    typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);

  const checks: SiteReadinessCheck[] = [
    probeCheck('probe.online', '网络在线', online, online ? '已连接' : '浏览器离线，请连接网络后重试'),
    probeCheck('probe.indexeddb', 'IndexedDB 可用', indexedDb, indexedDb ? '可用' : '浏览器不支持/已禁用 IndexedDB'),
    probeCheck('probe.webgl', 'WebGL 可用', webgl, webgl ? '可用' : '缺少 WebGL，3D 场景不可用'),
    probeCheck('probe.vibration', '振动 API 可用', vibration, vibration ? '可用' : '当前设备不支持振动'),
    probeCheck('probe.barcode', '条形码检测 API 可用', barcodeDetector, barcodeDetector ? '可用' : '需手动输入或使用扫码枪'),
    probeCheck('probe.camera', '摄像头捕获可用', cameraCapture, cameraCapture ? '可用' : '当前环境不支持摄像头采集'),
  ];

  return {
    checks,
    online,
    indexedDb,
    webgl,
    vibration,
    barcodeDetector,
    cameraCapture,
    runsAt: new Date().toISOString(),
  };
}

export interface BackendProbeResult {
  reachable: boolean;
  latencyMs?: number;
  error?: string;
}

function getApiBaseUrl(): string {
  // 应用与 API 同源部署（VITE_API_BASE_URL 默认 ''），健康探针用相对路径即可。
  return '';
}

/**
 * 探测后端连通性：请求 public 的 /health/live。可注入 fetchImpl 与 baseUrl 便于测试。
 * TODO(后端): 真实环境探测（Docker/K8s/Helm/对象存储/真实设备）需后端提供对应接口。
 */
export async function probeBackendConnectivity(
  fetchImpl: typeof fetch = fetch,
  baseUrl: string = getApiBaseUrl(),
): Promise<BackendProbeResult> {
  const start = Date.now();
  try {
    const res = await fetchImpl(`${baseUrl}/health/live`, { method: 'GET' });
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      return { reachable: false, latencyMs, error: `HTTP ${res.status}` };
    }
    return { reachable: true, latencyMs };
  } catch (error) {
    return {
      reachable: false,
      error: error instanceof Error ? error.message : '后端不可达',
    };
  }
}

/**
 * 针对可探测问题生成修复建议（仅提示，不自动执行任何修改）。
 * 真实环境修复需现场操作，这里只给出文案。
 */
export function repairSuggestionsForProbe(
  probe: SiteReadinessProbeResult,
): RepairSuggestion[] {
  const suggestions: RepairSuggestion[] = [];
  if (!probe.online) {
    suggestions.push({
      id: 'fix.online',
      stageId: 'F0',
      message: '浏览器离线，请连接网络后重试（仅提示，不自动执行）。',
    });
  }
  if (!probe.indexedDb) {
    suggestions.push({
      id: 'fix.indexeddb',
      stageId: 'F0',
      message: 'IndexedDB 不可用，本地数据暂存能力受限，请检查浏览器设置。',
    });
  }
  if (!probe.webgl) {
    suggestions.push({
      id: 'fix.webgl',
      stageId: 'F1',
      message: '缺少 WebGL，3D 场景不可用，请升级浏览器或启用硬件加速。',
    });
  }
  if (!probe.barcodeDetector) {
    suggestions.push({
      id: 'fix.barcode',
      stageId: 'F2',
      message: '无条形码检测 API，请使用扫码枪或手动输入。',
    });
  }
  if (!probe.cameraCapture) {
    suggestions.push({
      id: 'fix.camera',
      stageId: 'F2',
      message: '无摄像头采集能力，请检查设备或浏览器权限。',
    });
  }
  return suggestions;
}