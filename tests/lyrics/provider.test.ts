import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('native lyric provider', () => {
  const registerProvider = vi.fn();
  const unregisterProvider = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    (globalThis as typeof globalThis & { songloft: unknown }).songloft = {
      lyrics: { registerProvider, unregisterProvider },
      log: { info: vi.fn() },
    };
  });

  it('registers only when explicitly enabled and unregisters when disabled', async () => {
    const { applyLyricProvider, getLyricProviderStatus } = await import('../../src/lyrics/provider');
    applyLyricProvider({ provider_enabled: false });
    expect(registerProvider).not.toHaveBeenCalled();
    applyLyricProvider({ provider_enabled: true });
    expect(registerProvider).toHaveBeenCalledOnce();
    expect(getLyricProviderStatus(true)).toMatchObject({ enabled: true, registered: true, available: true });
    applyLyricProvider({ provider_enabled: false });
    expect(unregisterProvider).toHaveBeenCalledOnce();
  });
});
