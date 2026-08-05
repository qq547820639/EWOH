import { useCallback, useState } from 'react';
import {
  clearSettings,
  readSettings,
  saveSettings,
  type WorkbenchSettings,
} from '../../lib/offlineSettings';

/**
 * React wrapper around the per-user + per-device workbench settings persistence
 * (scan / touch / one-hand / glove modes). Setters write through and update
 * local React state so the UI reflects the choice immediately.
 */
export function useOfflineSettings(
  userId: string,
): {
  settings: WorkbenchSettings;
  update: (patch: WorkbenchSettings) => void;
  reset: () => void;
} {
  const [settings, setSettings] = useState<WorkbenchSettings>(() =>
    readSettings(userId),
  );

  const update = useCallback(
    (patch: WorkbenchSettings) => {
      setSettings(saveSettings(userId, patch));
    },
    [userId],
  );

  const reset = useCallback(() => {
    clearSettings(userId);
    setSettings({});
  }, [userId]);

  return { settings, update, reset };
}