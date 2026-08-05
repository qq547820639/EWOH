/**
 * Multi-input support for the Role Workbench (UX-001 / spec item on input
 * methods): keyboard, USB scanner gun, touch, one-handed and industrial-glove
 * interaction. Pure functions so they are unit-testable in a node jest
 * environment. The scanner itself is provided by `client/src/lib/scanner.ts`
 * (`createScannerListener`); this module decides how a scanned value lands in a
 * list filter and how large touch targets must be for a given input mode.
 */

import {
  createScannerListener,
  type ScannerListener,
  type ScannerOptions,
} from '../../lib/scanner';

export type WorkbenchInputMode =
  | 'keyboard'
  | 'scan'
  | 'touch'
  | 'singlehand'
  | 'glove';

/** WCAG / platform recommended minimum touch target in px. */
export const MIN_TOUCH_TARGET = 44;

/** Enlarged target for industrial gloves / one-handed operation. */
export const GLOVE_TARGET = 64;

/** Returns the minimum interactive target size for the given input mode. */
export function touchTargetSize(mode: WorkbenchInputMode): number {
  switch (mode) {
    case 'glove':
    case 'singlehand':
      return GLOVE_TARGET;
    case 'touch':
    case 'scan':
      return MIN_TOUCH_TARGET;
    case 'keyboard':
    default:
      return MIN_TOUCH_TARGET;
  }
}

export interface InputCapabilities {
  hasTouch?: boolean;
  coarsePointer?: boolean;
  glove?: boolean;
  singleHand?: boolean;
}

/**
 * Infers the dominant input mode from platform capabilities. Glove mode wins
 * for maximum target size; otherwise a coarse pointer without a fine mouse
 * implies touch.
 */
export function inferInputMode(caps: InputCapabilities): WorkbenchInputMode {
  if (caps.glove) return 'glove';
  if (caps.singleHand) return 'singlehand';
  if (caps.coarsePointer) return 'touch';
  if (caps.hasTouch) return 'touch';
  return 'keyboard';
}

/**
 * Merges a scanner-gun value into the current list filter. Appends on a
 * non-empty scan so partial manual input is preserved, separated by a space.
 */
export function mergeScannedValue(current: string, scanned: string): string {
  const scan = scanned.trim();
  if (!scan) return current;
  if (!current.trim()) return scan;
  return `${current.trim()} ${scan}`;
}

export interface WorkbenchShortcut {
  key: string;
  /** Ctrl/Cmd must be held. */
  modifier?: 'ctrl' | 'meta' | 'none';
  action: string;
}

export const WORKBENCH_SHORTCUTS: WorkbenchShortcut[] = [
  { key: 'f', action: 'focus-filter' },
  { key: 'r', action: 'refresh' },
  { key: 's', action: 'save-view' },
  { key: 'Enter', action: 'activate-row' },
];

/**
 * Matches a keyboard event against the workbench shortcuts. Returns the action
 * name or null. `meta` accepts Cmd on macOS, `ctrl` accepts Ctrl on the rest.
 */
export function matchShortcut(
  event: { key: string; ctrlKey?: boolean; metaKey?: boolean },
  shortcuts: WorkbenchShortcut[] = WORKBENCH_SHORTCUTS,
): string | null {
  for (const shortcut of shortcuts) {
    if (event.key.toLowerCase() !== shortcut.key.toLowerCase()) continue;
    if (shortcut.modifier === 'ctrl' && !event.ctrlKey) continue;
    if (shortcut.modifier === 'meta' && !(event.ctrlKey || event.metaKey)) continue;
    return shortcut.action;
  }
  return null;
}

/**
 * Creates a scanner listener wired to a workbench filter. Uses the same
 * `createScannerListener` used across the app so a USB scanner gun behaves
 * identically. Exported for direct reuse in tests.
 */
export function createWorkbenchScanner(
  handlers: { onScan: (value: string) => void; onDuplicate?: (value: string) => void; onError?: (message: string) => void },
  options?: ScannerOptions,
): ScannerListener {
  return createScannerListener(handlers, options);
}