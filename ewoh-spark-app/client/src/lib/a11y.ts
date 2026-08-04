export const MIN_TEXT_CONTRAST = 4.5;
export const MIN_NON_TEXT_CONTRAST = 3;

/** 与 tailwind-theme.css 保持一致的对比度 token。 */
export const MUTED_FOREGROUND = 'hsl(218 10% 42%)';
export const FOCUS_RING = 'hsl(221 83% 53%)';

export const UI_ARIA_LABELS = {
  skipToContent: '跳到主内容',
  openNavigation: '打开导航',
  closeNavigation: '关闭导航',
  logout: '退出登录',
  zoomIn: '放大地图',
  zoomOut: '缩小地图',
  resetView: '重置地图视图',
  searchEntities: '搜索实体',
  closeEntityDetail: '关闭实体详情',
  enterReplay: '进入回放模式',
  exitReplay: '退出回放模式',
  pauseReplay: '暂停回放',
  resumeReplay: '继续回放',
  closeHelp: '关闭快捷键帮助',
  expandAlertList: '展开告警列表',
  collapseAlertList: '收起告警列表',
  dismissAlertToast: '关闭告警提示',
  viewAlert: '查看告警详情',
  handleAlert: '快速处置告警',
  expandPlan: '展开方案详情',
  collapsePlan: '收起方案详情',
  editProcess: '编辑工序',
  deleteProcess: '删除工序',
  graphTextView: '切换到文本视图',
  graphGraphView: '切换到图形视图',
  graphSummary: '交付因果图（文本替代）',
  graphCriticalPath: '关键路径',
  searchPersonnel: '搜索人员',
  batteryChart: '设备电量分布图',
} as const;

export function eventAccessibleLabel(title: string, severity: string): string {
  return `${title}，${severity} 级事件，点击查看详情`;
}

function normalizeHsl(value: string): { h: number; s: number; l: number } {
  const compact = value.replace(/_/g, ' ').replace(/,/g, ' ');
  const match = compact.trim().match(/^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/i);
  if (!match) {
    throw new Error(`不支持的 HSL 颜色: ${value}`);
  }
  return {
    h: Number(match[1]),
    s: Number(match[2]),
    l: Number(match[3]),
  };
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const saturation = s / 100;
  const lightness = l / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const hue = ((h % 360) + 360) % 360 / 60;
  const x = chroma * (1 - Math.abs((hue % 2) - 1));
  let rgb: [number, number, number];
  if (hue < 1) rgb = [chroma, x, 0];
  else if (hue < 2) rgb = [x, chroma, 0];
  else if (hue < 3) rgb = [0, chroma, x];
  else if (hue < 4) rgb = [0, x, chroma];
  else if (hue < 5) rgb = [x, 0, chroma];
  else rgb = [chroma, 0, x];
  const match = lightness - chroma / 2;
  return rgb.map((channel) => Math.round((channel + match) * 255)) as [
    number,
    number,
    number,
  ];
}

function hexToRgb(value: string): [number, number, number] {
  const hex = value.replace('#', '');
  if (hex.length === 3) {
    return [
      Number.parseInt(hex[0] + hex[0], 16),
      Number.parseInt(hex[1] + hex[1], 16),
      Number.parseInt(hex[2] + hex[2], 16),
    ];
  }
  if (hex.length !== 6) {
    throw new Error(`不支持的 HEX 颜色: ${value}`);
  }
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

export function parseColor(color: string): [number, number, number] {
  const trimmed = color.trim();
  if (trimmed.startsWith('#')) return hexToRgb(trimmed);
  if (trimmed.toLowerCase().startsWith('hsl')) {
    const { h, s, l } = normalizeHsl(trimmed);
    return hslToRgb(h, s, l);
  }
  throw new Error(`不支持的 CSS 颜色: ${color}`);
}

function channelLuminance(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(color: string): number {
  const [r, g, b] = parseColor(color);
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

export function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

export function isReadableText(
  foreground: string,
  background: string,
  minRatio = MIN_TEXT_CONTRAST,
): boolean {
  return contrastRatio(foreground, background) >= minRatio;
}
