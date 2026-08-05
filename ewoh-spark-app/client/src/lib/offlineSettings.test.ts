import {
  clearSettings,
  getDeviceId,
  readSettings,
  saveSettings,
  settingsKey,
  type StorageLike,
} from './offlineSettings';

function createStorage(initial: Record<string, string> = {}): StorageLike {
  const values = { ...initial };
  return {
    getItem: (key: string) => values[key] ?? null,
    setItem: (key: string, value: string) => {
      values[key] = value;
    },
    removeItem: (key: string) => {
      delete values[key];
    },
  };
}

describe('offlineSettings', () => {
  it('scopes settings by user + device so users/devices never leak', () => {
    const storage = createStorage();
    const deviceA = getDeviceId(storage);
    // Two users on the same device get distinct keys.
    saveSettings('user-1', { touchMode: true, scanMode: 'camera' }, storage);
    saveSettings('user-2', { gloveMode: true }, storage);
    expect(readSettings('user-1', storage)).toEqual({
      touchMode: true,
      scanMode: 'camera',
    });
    expect(readSettings('user-2', storage)).toEqual({ gloveMode: true });
    expect(settingsKey('user-1', deviceA)).not.toBe(settingsKey('user-2', deviceA));
  });

  it('persists settings across reads (survives storage round-trip)', () => {
    const storage = createStorage();
    saveSettings('user-1', { oneHandMode: true }, storage);
    // A fresh read from the same storage returns the persisted value.
    expect(readSettings('user-1', storage)).toEqual({ oneHandMode: true });
  });

  it('merges patches and keeps previously-set fields', () => {
    const storage = createStorage();
    saveSettings('u', { touchMode: true }, storage);
    const merged = saveSettings('u', { scanMode: 'scanner' }, storage);
    expect(merged).toEqual({ touchMode: true, scanMode: 'scanner' });
    expect(readSettings('u', storage)).toEqual({ touchMode: true, scanMode: 'scanner' });
  });

  it('clearSettings removes the stored settings for the device', () => {
    const storage = createStorage();
    saveSettings('u', { gloveMode: true }, storage);
    clearSettings('u', storage);
    expect(readSettings('u', storage)).toEqual({});
  });

  it('returns empty when storage is unavailable', () => {
    expect(readSettings('u', null as unknown as StorageLike)).toEqual({});
  });
});