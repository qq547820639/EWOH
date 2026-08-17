/**
 * UX-001 触觉/声音反馈（可配置）—— 状态不可仅靠颜色区分。
 *
 * 提供 soundEnabled / vibrationEnabled 两个开关，以及三个业务事件通知：
 *   notifyScanSuccess()      扫码成功
 *   notifyCriticalFailure()  关键失败（如异常/停机）
 *   notifyOfflineSaved()     离线保存入队
 * 开关关闭或浏览器不支持时均为安全 no-op，不抛错。
 */

export interface FeedbackConfig {
  soundEnabled: boolean;
  vibrationEnabled: boolean;
}

const DEFAULT_CONFIG: FeedbackConfig = {
  soundEnabled: true,
  vibrationEnabled: true,
};

let config: FeedbackConfig = { ...DEFAULT_CONFIG };

/** 开启/关闭声音或振动反馈。 */
export function setFeedbackConfig(next: Partial<FeedbackConfig>): void {
  config = { ...config, ...next };
}

/** 读取当前反馈配置（返回副本，避免外部篡改）。 */
export function getFeedbackConfig(): Readonly<FeedbackConfig> {
  return { ...config };
}

export function isSoundEnabled(): boolean {
  return config.soundEnabled;
}

export function isVibrationEnabled(): boolean {
  return config.vibrationEnabled;
}

function vibrate(pattern: number[]): void {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') {
    return;
  }
  try {
    navigator.vibrate(pattern);
  } catch {
    // 振动为 best-effort，忽略失败。
  }
}

/** CLI-535：AudioContext 单例——每次 beep 新建 context 会快速耗尽浏览器
 * 的 AudioContext 数量上限（Chrome 约每页面 6 个挂起实例）。 */
let sharedAudioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    if (!sharedAudioContext) {
      sharedAudioContext = new Ctor();
    }
    return sharedAudioContext;
  } catch {
    return null;
  }
}

function beep(frequency: number, durationMs: number): void {
  const context = getAudioContext();
  if (!context) return;
  try {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.15, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(
      0.001,
      context.currentTime + durationMs / 1000,
    );
    oscillator.start();
    oscillator.stop(context.currentTime + durationMs / 1000);
    // CLI-535：复用共享 context，不再在 onended 关闭。
  } catch {
    // 音频为 best-effort，忽略失败。
  }
}

/** 扫码成功：高音短提示 + 短振动。 */
export function notifyScanSuccess(): void {
  if (config.soundEnabled) beep(880, 120);
  if (config.vibrationEnabled) vibrate([60]);
}

/** 关键失败：低音长提示 + 长振动。 */
export function notifyCriticalFailure(): void {
  if (config.soundEnabled) beep(220, 300);
  if (config.vibrationEnabled) vibrate([200]);
}

/** 离线保存：中音提示 + 三连振动。 */
export function notifyOfflineSaved(): void {
  if (config.soundEnabled) beep(440, 120);
  if (config.vibrationEnabled) vibrate([40, 40, 40]);
}