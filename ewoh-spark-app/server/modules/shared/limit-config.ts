/** Parse a positive-integer limit setting; invalid values must remain visible. */
export function readPositiveIntSetting(
  value: string | undefined,
  fallback: number,
  label: string,
  onInvalid?: (message: string) => void,
): number {
  const raw = (value ?? '').trim();
  if (raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    onInvalid?.(
      `非法 ${label} "${value}"，回退默认 ${fallback}（限流配置错误不得静默禁用门禁）`,
    );
    return fallback;
  }
  return parsed;
}
