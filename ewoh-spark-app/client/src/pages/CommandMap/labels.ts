const ELLIPSIS = '…';

/** 按可用像素宽度裁剪 SVG 标签，空间不足时返回 null（隐藏标签）。 */
export function fitLabel(name: string, boxWidthPx: number, fontSizePx: number): string | null {
  if (!name || boxWidthPx <= 0 || fontSizePx <= 0) return null;
  if (boxWidthPx < fontSizePx * 2.4) return null;
  const maxChars = Math.max(3, Math.floor(boxWidthPx / (fontSizePx * 0.62)));
  return truncateLabel(name, maxChars);
}

/** 固定长度截断，保留省略号。 */
export function truncateLabel(name: string, maxChars: number): string {
  if (!name) return '';
  if (maxChars <= 1) return ELLIPSIS;
  if (name.length <= maxChars) return name;
  return `${name.slice(0, maxChars - 1).trimEnd()}${ELLIPSIS}`;
}
