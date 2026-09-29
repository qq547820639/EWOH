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

  it('encodes key fragments so delimiter combinations cannot collide', () => {
    const storage = createStorage();
    saveSettings('a.b', { touchMode: true }, storage);
    saveSettings('a', { touchMode: false }, storage);
    expect(readSettings('a.b', storage)).toEqual({ touchMode: true });
    expect(readSettings('a', storage)).toEqual({ touchMode: false });
    expect(settingsKey('a.b', 'c')).not.toBe(settingsKey('a', 'b.c'));
  });

  it('drops unknown fields and prototype-shaped payloads from storage', () => {
    const storage = createStorage();
    const deviceId = getDeviceId(storage);
    storage.setItem(
      settingsKey('u', deviceId),
      JSON.stringify({
        touchMode: 'yes',
        scanMode: 'hacker',
        unknown: true,
        __proto__: { gloveMode: true },
      }),
    );
    expect(readSettings('u', storage)).toEqual({});

    const merged = saveSettings(
      'u',
      {
        touchMode: true,
        scanMode: 'camera',
        unknown: true,
      } as never,
      storage,
    );
    expect(merged).toEqual({ touchMode: true, scanMode: 'camera' });
    expect(JSON.parse(storage.getItem(settingsKey('u', deviceId))!)).toEqual({
      touchMode: true,
      scanMode: 'camera',
    });
  });

  it('sanitizes patches even when storage is unavailable', () => {
    expect(
      saveSettings('u', { touchMode: 'yes', unknown: true } as never, null as unknown as StorageLike),
    ).toEqual({});
  });

  it('returns empty when storage is unavailable', () => {
    expect(readSettings('u', null as unknown as StorageLike)).toEqual({});
  });
});