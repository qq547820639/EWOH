export type ScanFeedbackKind = 'success' | 'fail' | 'duplicate';

/** Minimal W3C BarcodeDetector API types (not yet in the default TS DOM lib). */
declare global {
  interface BarcodeDetectorOptions {
    formats: string[];
  }
  interface DetectedBarcode {
    rawValue: string;
    format: string;
  }
  class BarcodeDetector {
    constructor(options?: BarcodeDetectorOptions);
    detect(
      source: ImageBitmap | HTMLImageElement | HTMLVideoElement,
    ): Promise<DetectedBarcode[]>;
  }
}

/**
 * Vibration patterns for each feedback kind (navigator.vibrate accepts arrays
 * of [vibrate, pause, vibrate, ...] in ms). Returns null when unsupported.
 */
export function vibratePattern(kind: ScanFeedbackKind): number[] | null {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') {
    return null;
  }
  return kind === 'success'
    ? [60]
    : kind === 'duplicate'
      ? [40, 40, 40]
      : [200];
}

/** Plays a short WebAudio beep. Success = high tone, duplicate = mid, fail = low. */
export function playBeep(kind: ScanFeedbackKind): void {
  if (typeof window === 'undefined') {
    return;
  }
  const frequency =
    kind === 'success' ? 880 : kind === 'duplicate' ? 440 : 220;
  const duration = kind === 'fail' ? 300 : 120;
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) {
      return;
    }
    const context = new Ctor();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.15, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(
      0.001,
      context.currentTime + duration / 1000,
    );
    oscillator.start();
    oscillator.stop(context.currentTime + duration / 1000);
    oscillator.onended = () => {
      void context.close();
    };
  } catch {
    // Audio is best-effort; ignore failures.
  }
}

/** Vibrates and beeps for the given feedback kind. */
export function playScanFeedback(kind: ScanFeedbackKind): void {
  const pattern = vibratePattern(kind);
  if (pattern && typeof navigator !== 'undefined') {
    void navigator.vibrate(pattern);
  }
  playBeep(kind);
}

export interface ScannerHandlers {
  onScan: (value: string) => void;
  onDuplicate?: (value: string) => void;
  onError?: (message: string) => void;
}

export interface ScannerOptions {
  /** Max gap between keystrokes before a partial barcode is discarded (ms). */
  timeoutMs?: number;
  /** Minimum length to consider a captured sequence a valid barcode. */
  minLength?: number;
}

export interface ScannerListener {
  handleKeyDown(event: KeyboardEvent): void;
  reset(): void;
  /** Returns the current buffered value. */
  getBuffer(): string;
}

/**
 * Creates a listener for USB scanner-gun style keyboard input. Scanners type the
 * barcode then send Enter; we buffer alphanumeric keys, reset on interlocks
 * (Shift/Alt/Command/Ctrl) and other keys, and fire `onScan` on Enter.
 */
export function createScannerListener(
  handlers: ScannerHandlers,
  options?: ScannerOptions,
): ScannerListener {
  const timeoutMs = options?.timeoutMs ?? 300;
  const minLength = options?.minLength ?? 3;
  let buffer = '';
  let lastCharAt = 0;

  const flush = (): string => {
    const value = buffer;
    buffer = '';
    return value;
  };

  return {
    reset() {
      buffer = '';
      lastCharAt = 0;
    },
    getBuffer() {
      return buffer;
    },
    handleKeyDown(event) {
      const now = Date.now();
      if (buffer && now - lastCharAt > timeoutMs) {
        buffer = '';
      }
      lastCharAt = now;

      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        const value = flush();
        if (value.length >= minLength) {
          handlers.onScan(value);
        } else if (handlers.onError) {
          handlers.onError('扫码内容过短');
        }
        return;
      }

      if (
        event.key === 'Shift' ||
        event.key === 'Alt' ||
        event.key === 'Meta' ||
        event.key === 'Control'
      ) {
        return;
      }
      // Only accept printable single characters (barcode scanners emit ASCII).
      if (event.key.length === 1 && /^[\x20-\x7E]$/.test(event.key)) {
        buffer += event.key;
        return;
      }
      // Any other functional key interrupts an in-progress scan.
      buffer = '';
    },
  };
}

/** Whether the platform provides the W3C BarcodeDetector API. */
export function hasBarcodeDetector(): boolean {
  return typeof BarcodeDetector !== 'undefined';
}

/**
 * Detects a barcode from an image file. Uses the W3C BarcodeDetector when
 * available; otherwise rejects with a clear message so the UI can fall back to
 * manual input. This is the "camera / photo" path.
 */
export async function detectBarcodeFromFile(file: File): Promise<string | null> {
  if (!hasBarcodeDetector()) {
    throw new Error('当前设备不支持自动条码识别，请手动输入或使用扫码枪');
  }
  const detector = new BarcodeDetector({
    formats: ['qr_code', 'code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e'],
  });
  const bitmap = await createImageBitmap(file);
  try {
    const results = await detector.detect(bitmap);
    if (results.length === 0) {
      return null;
    }
    return results[0].rawValue;
  } finally {
    bitmap.close();
  }
}

/** Whether the device can open a rear camera for scanning. */
export function supportsCameraCapture(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }
  return Boolean(navigator.mediaDevices?.getUserMedia);
}