import { useEffect } from 'react';

export interface ShortcutConfig {
  /** Available modes; pressing digit `n` selects modes[n-1]. */
  modes: string[];
  onModeChange: (mode: string) => void;
  /** Cycle through L0/L1/L2/L3/L4. */
  onLevelToggle: () => void;
  /** Enter or leave replay mode. */
  onReplayToggle: () => void;
  /** Pause or continue replay. */
  onReplayPauseToggle: () => void;
  onCancelSelection: () => void;
  onFullscreen: () => void;
  onSearchFocus: () => void;
  onShowHelp: () => void;
  enabled: boolean;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (target.isContentEditable) return true;
  return false;
}

export function useKeyboardShortcuts(config: ShortcutConfig): void {
  const {
    modes,
    onModeChange,
    onLevelToggle,
    onReplayToggle,
    onReplayPauseToggle,
    onCancelSelection,
    onFullscreen,
    onSearchFocus,
    onShowHelp,
    enabled,
  } = config;

  useEffect(() => {
    if (!enabled) return;

    const handler = (e: KeyboardEvent) => {
      // Ignore when focus is in an input/textarea/select/contenteditable element
      // unless the user pressed Escape (which should always cancel selection).
      const editable = isEditableTarget(e.target);
      if (editable && e.key !== 'Escape') return;

      // Digit keys 1-9: switch modes[index]
      if (/^[1-9]$/.test(e.key)) {
        const idx = parseInt(e.key, 10) - 1;
        if (idx >= 0 && idx < modes.length) {
          e.preventDefault();
          onModeChange(modes[idx]);
        }
        return;
      }

      const key = e.key.toLowerCase();

      switch (key) {
        case 'l':
          e.preventDefault();
          onLevelToggle();
          break;
        case 't':
          e.preventDefault();
          onReplayToggle();
          break;
        case ' ':
        case 'spacebar':
          e.preventDefault();
          onReplayPauseToggle();
          break;
        case 'escape':
          e.preventDefault();
          onCancelSelection();
          break;
        case 'f':
          e.preventDefault();
          onFullscreen();
          break;
        case '/':
          e.preventDefault();
          onSearchFocus();
          break;
        case '?':
          e.preventDefault();
          onShowHelp();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    enabled,
    modes,
    onModeChange,
    onLevelToggle,
    onReplayToggle,
    onReplayPauseToggle,
    onCancelSelection,
    onFullscreen,
    onSearchFocus,
    onShowHelp,
  ]);
}
