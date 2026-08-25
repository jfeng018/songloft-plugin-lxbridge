import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('lyric settings', () => {
  const values = new Map<string, unknown>();

  beforeEach(() => {
    values.clear();
    vi.resetModules();
    (globalThis as typeof globalThis & { songloft: unknown }).songloft = {
      persistentStorage: {
        get: vi.fn(async (key: string) => values.get(key)),
        set: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }),
      },
    };
  });

  it('uses safe defaults', async () => {
    const { getLyricSettings } = await import('../../src/lyrics/settings');
    await expect(getLyricSettings()).resolves.toEqual({
      auto_fetch: true,
      provider_enabled: false,
      fallback_enabled: true,
      preferred_source: 'auto',
      translation_mode: 'merge',
      request_interval_ms: 600,
    });
  });

  it('persists and normalizes preferences', async () => {
    const { getLyricSettings, setLyricSettings } = await import('../../src/lyrics/settings');
    await expect(setLyricSettings({
      auto_fetch: false,
      provider_enabled: true,
      fallback_enabled: false,
      preferred_source: 'wy',
      translation_mode: 'translation',
      request_interval_ms: 50,
    })).resolves.toEqual({
      auto_fetch: false,
      provider_enabled: true,
      fallback_enabled: false,
      preferred_source: 'wy',
      translation_mode: 'translation',
      request_interval_ms: 300,
    });
    await expect(getLyricSettings()).resolves.toMatchObject({
      auto_fetch: false,
      provider_enabled: true,
      fallback_enabled: false,
      translation_mode: 'translation',
      request_interval_ms: 300,
    });
  });

  it('falls back to automatic source for an invalid preference', async () => {
    const { setLyricSettings } = await import('../../src/lyrics/settings');
    await expect(setLyricSettings({ preferred_source: 'invalid' as never })).resolves.toMatchObject({ preferred_source: 'auto' });
  });
});
